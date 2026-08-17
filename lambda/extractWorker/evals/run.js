// Eval harness for extractWorker. Exercises the real prompt-building and
// Claude-calling code from ../extract.js against a small fixture set —
// never DynamoDB or SQS, since that plumbing is already covered by manual
// testing and CloudWatch.
//
// Grading is almost entirely deterministic: does the output match the
// schema (guaranteed by output_config.format, but checked anyway in case
// the API version changes), and does it reconcile arithmetically — do
// segment revenues sum sensibly against total revenue, is the guidance
// range well-formed. Same "check the math, not just the vibes" approach
// chatApplication's design doc discusses.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node evals/run.js
// (run from lambda/extractWorker/ so ../extract and ./cases resolve correctly)

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { buildUserTurn, callClaude } = require("../extract");

const MODEL = process.env.MODEL || "claude-haiku-4-5";
const EVAL_MAX_TOKENS = 2048;
const DOCUMENT_TRUNCATE_CHARS = 20000; // fixtures are small; this is a defensive ceiling, not a normal-path limit

// Haiku 4.5 list pricing per million tokens — keep in sync with
// infrastructure/observability.tf.
const INPUT_PRICE_PER_MTOK = 1;
const OUTPUT_PRICE_PER_MTOK = 5;

function loadFixtures() {
  const dir = path.join(__dirname, "cases");
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
}

function checkSchemaShape(result) {
  const requiredKeys = [
    "company", "ticker", "fiscalPeriod", "revenue", "eps",
    "operatingMarginPct", "guidance", "segmentBreakdown",
    "notableEvents", "managementQuotes",
  ];
  const missing = requiredKeys.filter((key) => !(key in result));
  return missing.length ? `missing keys: ${missing.join(", ")}` : null;
}

// "Check the math, not just the vibes" — segment revenues shouldn't wildly
// exceed total reported revenue (some slack for rounding/unallocated
// corporate revenue, but not double).
function checkSegmentsReconcile(result) {
  if (!result.revenue?.actual || !result.segmentBreakdown?.length) return null;
  const segmentTotal = result.segmentBreakdown.reduce((sum, s) => sum + (s.revenue || 0), 0);
  if (segmentTotal > result.revenue.actual * 1.1) {
    return `segment revenues (${segmentTotal}) exceed total revenue (${result.revenue.actual}) by more than 10%`;
  }
  return null;
}

function checkGuidanceWellFormed(result) {
  const range = result.guidance?.nextPeriodRevenue;
  if (!range) return null; // null guidance is valid — not every document gives forward guidance
  if (typeof range !== "string" || !/\d/.test(range)) {
    return `guidance.nextPeriodRevenue doesn't look like a range: "${range}"`;
  }
  return null;
}

function runChecks(fixture, result) {
  const checks = [checkSchemaShape, checkSegmentsReconcile, checkGuidanceWellFormed];
  const failures = checks.map((check) => check(result)).filter(Boolean);

  for (const expectation of fixture.expect || []) {
    const actual = expectation.path.split(".").reduce((obj, key) => obj?.[key], result);
    if (actual !== expectation.equals) {
      failures.push(`expected ${expectation.path} === ${JSON.stringify(expectation.equals)}, got ${JSON.stringify(actual)}`);
    }
  }

  return failures;
}

async function runFixture(client, fixture, usage) {
  const userTurn = buildUserTurn({
    documentText: fixture.documentText,
    documentType: fixture.documentType,
    truncateChars: DOCUMENT_TRUNCATE_CHARS,
  });

  const response = await callClaude({ client, model: MODEL, maxTokens: EVAL_MAX_TOKENS, userTurn });
  usage.inputTokens += response.usage?.input_tokens || 0;
  usage.outputTokens += response.usage?.output_tokens || 0;

  if (response.stop_reason === "refusal") {
    return { passed: false, failures: ["model refused to extract from this document"] };
  }

  const textBlock = response.content.find((block) => block.type === "text");
  const result = JSON.parse(textBlock.text);
  const failures = runChecks(fixture, result);

  return { passed: failures.length === 0, failures, result };
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
