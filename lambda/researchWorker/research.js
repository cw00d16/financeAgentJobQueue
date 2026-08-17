// The prompt-building + agentic loop, pulled out of index.js so the eval
// harness (evals/run.js) exercises the exact same code path production
// uses instead of a re-implementation that could drift from reality. This
// module deliberately knows nothing about DynamoDB or Secrets Manager —
// those stay in index.js. Anthropic client is passed in by the caller,
// not constructed here.

const RESEARCH_SYSTEM_PROMPT = `You are a financial research analyst. Given a company name, a set of already-extracted structured facts from that company's own filings (when available), and web search, synthesize a research report.

Ground every figure you cite in either the extracted facts you were given or a web search result — never invent numbers. Use web search for anything not already covered by the extracted facts: recent news, analyst sentiment, competitive context, or events after the extracted document's date. Prefer the extracted facts over web search when both cover the same figure — they came directly from the company's own filing.

Work efficiently: search only what you need to cover the report, then write a draft. You will get one chance afterward to verify and correct the draft before it's finalized.`;

const VERIFY_SYSTEM_PROMPT = `You are verifying a draft financial research report against the structured facts it was supposed to be grounded in.

Check that: every figure attributed to the extracted facts actually matches them, the report addresses the correct fiscal period, and no claim is fabricated or unsupported. Correct anything wrong, then output the final, verified report in the required structure. If the draft is already correct, output it as-is in the required structure.

If no extracted facts were provided as input, set usedExtractedFacts to false and say so explicitly in the executive summary — state plainly that this report is based on public research only, not on company-provided source documents.`;

// A nullable version of a base schema type, expressed as anyOf per the
// structured-outputs schema subset (no "type": [x, "null"] union arrays).
function nullable(schema) {
  return { anyOf: [schema, { type: "null" }] };
}

const RESEARCH_REPORT_SCHEMA = {
  type: "object",
  properties: {
    companyName: { type: "string" },
    fiscalPeriodCovered: nullable({ type: "string", description: 'e.g. "Q1 2026" — null if not applicable/known' }),
    executiveSummary: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          content: { type: "string" },
        },
        required: ["heading", "content"],
        additionalProperties: false,
      },
    },
    sourcesUsed: { type: "array", items: { type: "string" }, description: "URLs or citations from web search results actually used" },
    usedExtractedFacts: { type: "boolean", description: "Whether the extracted facts input was incorporated into this report" },
  },
  required: ["companyName", "fiscalPeriodCovered", "executiveSummary", "sections", "sourcesUsed", "usedExtractedFacts"],
  additionalProperties: false,
};

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function buildUserTurn({ companyName, extractedFacts, truncateChars }) {
  return [
    `<company>${companyName}</company>`,
    "",
    "<extracted_facts>",
    extractedFacts?.length
      ? truncate(JSON.stringify(extractedFacts), truncateChars)
      : "(none provided — research from web search only)",
    "</extracted_facts>",
    "",
    "Research this company and produce a report.",
  ].join("\n");
}

// Research phase: tool-enabled, loops while the server-side web_search
// tool loop hits its own internal round cap (stop_reason "pause_turn"),
// resending the conversation as-is to resume — no synthetic "Continue"
// message, per the documented pause_turn pattern. Bounded by
// maxIterations (the hard guardrail from README's Guardrails section) and
// by a cumulative token budget as a belt-and-suspenders backstop.
async function runResearchPhase({ client, model, maxTokens, userTurn, maxIterations, maxTotalTokens, maxSearchUses }) {
  let messages = [{ role: "user", content: userTurn }];
  let iterations = 0;
  let totalTokens = 0; // input+output combined — only used for the maxTotalTokens budget check below
  let inputTokens = 0; // true input tokens, tracked separately for correct $1/MTok billing
  let outputTokens = 0; // true output tokens, tracked separately for correct $5/MTok billing
  let searchCount = 0;
  let response;

  do {
    iterations += 1;

    // Re-declared every iteration with the REMAINING budget, not the full
    // maxSearchUses — a pause_turn resume is a fresh API call, and if the
    // server grants max_uses a fresh per-call allowance (unconfirmed by
    // docs, but the best fit for observed CI data: a run under
    // maxSearchUses=1/maxIterations=2 measured 12 total searches instead
    // of the expected ceiling of 2), re-sending the full cap every time
    // would let the effective ceiling scale with iterations
    // (maxSearchUses * maxIterations) instead of staying at maxSearchUses.
    // Once the budget is exhausted, drop the tool entirely so Claude
    // cannot search again regardless of what the server would otherwise
    // allow — this is a hard client-side backstop, not dependent on
    // trusting max_uses semantics.
    const tools = [];
    if (!maxSearchUses || searchCount < maxSearchUses) {
      const webSearchTool = { type: "web_search_20250305", name: "web_search" };
      if (maxSearchUses) webSearchTool.max_uses = maxSearchUses - searchCount;
      tools.push(webSearchTool);
    }

    response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: RESEARCH_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      // Basic (non-dynamic-filtering) web search — Haiku 4.5 doesn't
      // support the newer web_search_20260209 variant.
      tools,
      messages,
    });

    inputTokens += response.usage?.input_tokens || 0;
    outputTokens += response.usage?.output_tokens || 0;
    totalTokens = inputTokens + outputTokens;
    // Each web_search_tool_result block is one billed search ($10/1,000 —
    // see index.js's WEB_SEARCH_PRICE_PER_SEARCH) — a real cost on top of
    // tokens that the model's own usage totals don't include.
    searchCount += response.content.filter((block) => block.type === "web_search_tool_result").length;
    messages = [...messages, { role: "assistant", content: response.content }];
  } while (
    response.stop_reason === "pause_turn" &&
    iterations < maxIterations &&
    totalTokens < maxTotalTokens &&
    (!maxSearchUses || searchCount < maxSearchUses)
  );

  return { messages, iterations, inputTokens, outputTokens, totalTokens, searchCount, lastResponse: response };
}

// Verification/finalize phase: always exactly one call, tools removed so
// it cannot loop further, output_config.format forces the final
// structured report. This is what makes the iteration cap hard — total
// Claude calls per job never exceeds maxIterations (research phase) + 1.
async function runVerifyPhase({ client, model, maxTokens, messages }) {
  const verifyMessages = [
    ...messages,
    {
      role: "user",
      content: "Verify your draft above against the extracted facts you were given, then output the final report.",
    },
  ];

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: VERIFY_SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: RESEARCH_REPORT_SCHEMA } },
    messages: verifyMessages,
  });

  return response;
}

module.exports = {
  RESEARCH_SYSTEM_PROMPT,
  VERIFY_SYSTEM_PROMPT,
  RESEARCH_REPORT_SCHEMA,
  truncate,
  buildUserTurn,
  runResearchPhase,
  runVerifyPhase,
};
