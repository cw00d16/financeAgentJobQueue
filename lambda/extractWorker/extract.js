// The prompt-building + Claude call, pulled out of index.js so the eval
// harness (evals/run.js) exercises the exact same code path production
// uses instead of a re-implementation that could drift from reality. This
// module deliberately knows nothing about DynamoDB, SQS, or Secrets
// Manager — those stay in index.js. Anthropic client is passed in by the
// caller, not constructed here.

const SYSTEM_PROMPT = `You extract structured facts from a single earnings release or earnings call document. Fields are chosen by working backward from what a downstream research report needs to say, not by brainstorming anything that sounds financial.

Extract only what the document actually states. If a field genuinely isn't present in the document (e.g. no non-GAAP EPS was reported, or guidance wasn't given), use null for that field rather than guessing or fabricating a number. Do not infer figures that aren't explicitly stated.`;

// A nullable version of a base schema type, expressed as anyOf per the
// structured-outputs schema subset (no "type": [x, "null"] union arrays).
function nullable(schema) {
  return { anyOf: [schema, { type: "null" }] };
}

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    company: { type: "string", description: "Company name as stated in the document" },
    ticker: nullable({ type: "string", description: "Stock ticker symbol" }),
    fiscalPeriod: { type: "string", description: 'e.g. "Q1 2026"' },
    revenue: {
      type: "object",
      properties: {
        actual: { type: "number", description: "Total reported revenue, in dollars" },
        yoyGrowthPct: nullable({ type: "number", description: "Year-over-year revenue growth percentage" }),
      },
      required: ["actual", "yoyGrowthPct"],
      additionalProperties: false,
    },
    eps: {
      type: "object",
      properties: {
        gaap: nullable({ type: "number" }),
        nonGaap: nullable({ type: "number" }),
      },
      required: ["gaap", "nonGaap"],
      additionalProperties: false,
    },
    operatingMarginPct: nullable({ type: "number" }),
    guidance: {
      type: "object",
      properties: {
        nextPeriodRevenue: nullable({ type: "string", description: 'e.g. "1.28B-1.32B"' }),
        changedFromPriorGuidance: nullable({ type: "boolean" }),
      },
      required: ["nextPeriodRevenue", "changedFromPriorGuidance"],
      additionalProperties: false,
    },
    segmentBreakdown: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          revenue: { type: "number" },
        },
        required: ["name", "revenue"],
        additionalProperties: false,
      },
    },
    notableEvents: { type: "array", items: { type: "string" } },
    managementQuotes: { type: "array", items: { type: "string" } },
  },
  required: [
    "company", "ticker", "fiscalPeriod", "revenue", "eps",
    "operatingMarginPct", "guidance", "segmentBreakdown",
    "notableEvents", "managementQuotes",
  ],
  additionalProperties: false,
};

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function buildUserTurn({ documentText, documentType, truncateChars }) {
  return [
    `<document_type>${documentType || "earnings release or earnings call"}</document_type>`,
    "",
    "<document>",
    truncate(documentText, truncateChars),
    "</document>",
    "",
    "Extract the structured facts from the document above.",
  ].join("\n");
}

async function callClaude({ client, model, maxTokens, userTurn }) {
  return client.messages.create({
    model,
    max_tokens: maxTokens,
    // The system prompt is byte-identical on every call, so it's a clean
    // prompt-caching candidate — repeat calls pay a fraction of input
    // price for this block once it clears the model's minimum cacheable
    // prefix.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: { format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    messages: [{ role: "user", content: userTurn }],
  });
}

module.exports = { SYSTEM_PROMPT, EXTRACTION_SCHEMA, truncate, buildUserTurn, callClaude };
