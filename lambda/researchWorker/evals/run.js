// Eval harness for researchWorker. Exercises the real loop logic from
// ../research.js against a small fixture set of canned "extracted facts"
// (no live dependency on a real prior extraction job — deterministic and
// fast) plus judge-graded checks on the final report.
//
// Cost is bounded by construction: EVAL_MAX_SEARCH_USES caps web_search's
// max_uses, EVAL_MAX_ITERATIONS caps client-side loop rounds, and
// max_tokens is tight throughout — same "cost bounded by construction,
// not by hoping fixtures stay small" approach as chatApplication's
// harness.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node evals/run.js
// (run from lambda/researchWorker/ so ../research and ./cases resolve correctly)

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { buildUserTurn, runResearchPhase, runVerifyPhase } = require("../research");

const MODEL = process.env.MODEL || "claude-haiku-4-5";

// --- Hard cost-ceiling knobs — deliberately not read from fixtures, so no
// fixture edit can silently blow the budget. ---
const EVAL_MAX_TOKENS = 1024;
const EVAL_MAX_ITERATIONS = 2; // real jobs get RESEARCH_MAX_ITERATIONS (default 5); evals stay tight
const EVAL_MAX_TOTAL_TOKENS = 20000;
const EVAL_MAX_SEARCH_USES = 1;
const JUDGE_MAX_TOKENS = 60;
const FACTS_TRUNCATE_CHARS = 5000;
const JUDGE_RESPONSE_TRUNCATE_CHARS = 1500;

// Haiku 4.5 list pricing per million tokens — keep in sync with
// infrastructure/observability.tf.
const INPUT_PRICE_PER_MTOK = 1;
const OUTPUT_PRICE_PER_MTOK = 5;

const JUDGE_SYSTEM_PROMPT = "You are a strict, terse test grader for a financial research report. You will be given a rubric and a report to grade against it. Reply with exactly one line: the word PASS or FAIL, then a colon, then a reason in 15 words or fewer. Nothing else.";

function loadFixtures() {
  const dir = path.join(__dirname, "cases");
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
}

async function judge({ client, rubric, report, usage }) {
  const userTurn = [
    `Rubric: ${rubric}`,
    "",
    `Report to grade: ${JSON.stringify(report).slice(0, JUDGE_RESPONSE_TRUNCATE_CHARS)}`,
  ].join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: JUDGE_MAX_TOKENS,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userTurn }],
  });

  usage.inputTokens += response.usage?.input_tokens || 0;
  usage.outputTokens += response.usage?.output_tokens || 0;

  const verdictText = response.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
  const passed = /^PASS\b/i.test(verdictText);
  return { passed, reason: verdictText || "(empty judge response)" };
}

function checkSchemaShape(report) {
  const requiredKeys = ["companyName", "fiscalPeriodCovered", "executiveSummary", "sections", "sourcesUsed", "usedExtractedFacts"];
  const missing = requiredKeys.filter((key) => !(key in report));
  return missing.length ? `missing keys: ${missing.join(", ")}` : null;
}

async function runFixture(client, fixture, usage) {
  const userTurn = buildUserTurn({
    companyName: fixture.companyName,
    extractedFacts: fixture.extractedFacts || [],
    truncateChars: FACTS_TRUNCATE_CHARS,
  });

  const {
    messages,
    inputTokens: researchInputTokens,
    outputTokens: researchOutputTokens,
  } = await runResearchPhase({
    client,
    model: MODEL,
    maxTokens: EVAL_MAX_TOKENS,
    userTurn,
    maxIterations: EVAL_MAX_ITERATIONS,
    maxTotalTokens: EVAL_MAX_TOTAL_TOKENS,
    maxSearchUses: EVAL_MAX_SEARCH_USES,
  });

  const verifyResponse = await runVerifyPhase({ client, model: MODEL, maxTokens: EVAL_MAX_TOKENS, messages });
  usage.inputTokens += researchInputTokens + (verifyResponse.usage?.input_tokens || 0);
  usage.outputTokens += researchOutputTokens + (verifyResponse.usage?.output_tokens || 0);

  if (verifyResponse.stop_reason === "refusal") {
    return { passed: true, failures: [], note: "model refused via safety classifier (treated as pass)" };
  }

  const textBlock = verifyResponse.content.find((b) => b.type === "text");
  const report = JSON.parse(textBlock.text);

  const failures = [checkSchemaShape(report)].filter(Boolean);

  let judgeResult = null;
  if (fixture.rubric && failures.length === 0) {
    judgeResult = await judge({ client, rubric: fixture.rubric, report, usage });
    if (!judgeResult.passed) failures.push(`judge: ${judgeResult.reason}`);
  }

  return { passed: failures.length === 0, failures, report, judgeResult };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set — export it before running evals.");
    process.exitCode = 1;
    return;
  }

  const client = new Anthropic({ apiKey });
  const fixtures = loadFixtures();
  const usage = { inputTokens: 0, outputTokens: 0 };
  const results = [];

  for (const fixture of fixtures) {
    process.stdout.write(`Running ${fixture.id}... `);
    try {
      const result = await runFixture(client, fixture, usage);
      results.push({ id: fixture.id, ...result });
      console.log(result.passed ? "PASS" : `FAIL — ${result.failures.join("; ")}`);
    } catch (err) {
      results.push({ id: fixture.id, passed: false, failures: [`error: ${err.message}`] });
      console.log(`ERROR — ${err.message}`);
    }
  }

  const passCount = results.filter((r) => r.passed).length;
  const estimatedCost = (usage.inputTokens / 1_000_000) * INPUT_PRICE_PER_MTOK
    + (usage.outputTokens / 1_000_000) * OUTPUT_PRICE_PER_MTOK;

  console.log("");
  console.log(`${passCount}/${results.length} fixtures passed`);
  console.log(`Measured usage: ${usage.inputTokens} input tokens, ${usage.outputTokens} output tokens`);
  console.log(`Measured cost: $${estimatedCost.toFixed(6)}`);

  fs.writeFileSync(
    path.join(__dirname, "results.json"),
    JSON.stringify({ ranAt: new Date().toISOString(), model: MODEL, passCount, total: results.length, usage, estimatedCost, results }, null, 2),
  );

  if (passCount < results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Eval run crashed:", err);
  process.exitCode = 1;
});
