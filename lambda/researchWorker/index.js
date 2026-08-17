const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const Anthropic = require("@anthropic-ai/sdk");
const { buildUserTurn, runResearchPhase, runVerifyPhase } = require("./research");

const ddb = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(ddb);
const secretsClient = new SecretsManagerClient({});

const JOBS_TABLE = process.env.JOBS_TABLE;
const ANTHROPIC_SECRET_ARN = process.env.ANTHROPIC_SECRET_ARN;
const MAX_RECEIVE_COUNT = Number(process.env.MAX_RECEIVE_COUNT || 3);
// Haiku 4.5, matching extractWorker — upgrade to Sonnet only if the eval
// harness shows Haiku falling short on synthesis quality (README's
// "Keeping this cheap" section).
const MODEL = process.env.MODEL || "claude-haiku-4-5";
const MAX_TOKENS = Number(process.env.RESEARCH_MAX_TOKENS || 4096);
const FACTS_TRUNCATE_CHARS = Number(process.env.FACTS_TRUNCATE_CHARS || 100000);

// Per-job hard guardrails (README's Guardrails section) — scoped to one
// job's one execution, so they live in memory for that invocation. No
// extra DynamoDB table needed, unlike chatApplication's cross-request
// rate limiter.
const MAX_ITERATIONS = Number(process.env.RESEARCH_MAX_ITERATIONS || 5);
const MAX_TOTAL_TOKENS = Number(process.env.RESEARCH_MAX_TOTAL_TOKENS || 100000);
// Caps web_search's max_uses per research-phase call. Below this, Claude
// stops searching and writes with what it has instead of asking for more
// (stop_reason "pause_turn") — which also means the research phase reliably
// finishes in one call instead of the multi-iteration compounding case
// (up to MAX_ITERATIONS rounds of up to 10 searches each, uncapped) that an
// unset cap allows.
const MAX_SEARCH_USES = Number(process.env.RESEARCH_MAX_SEARCH_USES || 5);

// Haiku 4.5 list pricing per million tokens — keep in sync with
// infrastructure/observability.tf's haiku_input_price_per_mtok /
// haiku_output_price_per_mtok if the model or pricing ever changes.
const INPUT_PRICE_PER_MTOK = 1;
const OUTPUT_PRICE_PER_MTOK = 5;
// Web search is billed separately from tokens — $10 per 1,000 searches —
// and isn't reflected in response.usage at all, so it has to be counted
// from web_search_tool_result blocks (see research.js's runResearchPhase)
// and added on top of the token cost below.
const WEB_SEARCH_PRICE_PER_SEARCH = 0.01;

let cachedApiKey;
async function getApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: ANTHROPIC_SECRET_ARN }));
  cachedApiKey = secret.SecretString;
  return cachedApiKey;
}

let anthropicClient;
async function getClient() {
  if (anthropicClient) return anthropicClient;
  anthropicClient = new Anthropic({ apiKey: await getApiKey() });
  return anthropicClient;
}

function estimateCostUsd(inputTokens, outputTokens) {
  return (inputTokens / 1_000_000) * INPUT_PRICE_PER_MTOK + (outputTokens / 1_000_000) * OUTPUT_PRICE_PER_MTOK;
}

// Aliases every attribute name since several — status, result, error —
// collide with DynamoDB reserved words.
async function markStatus(jobId, fields) {
  const allFields = { ...fields, updatedAt: new Date().toISOString() };
  const names = {};
  const values = {};
  const sets = Object.keys(allFields).map((key) => {
    names[`#${key}`] = key;
    values[`:${key}`] = allFields[key];
    return `#${key} = :${key}`;
  });

  await db.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: { jobId },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function loadExtractedFacts(sourceExtractionJobIds) {
  if (!sourceExtractionJobIds || sourceExtractionJobIds.length === 0) return [];

  const facts = [];
  for (const sourceJobId of sourceExtractionJobIds) {
    const result = await db.send(new GetCommand({ TableName: JOBS_TABLE, Key: { jobId: sourceJobId } }));
    if (result.Item?.result) facts.push(result.Item.result);
  }
  return facts;
}

async function processRecord(record) {
  const { jobId } = JSON.parse(record.body);
  const receiveCount = Number(record.attributes?.ApproximateReceiveCount || 1);
  const isFinalAttempt = receiveCount >= MAX_RECEIVE_COUNT;
  const log = (fields) => console.log(JSON.stringify({ event: "job_processed", jobId, type: "research", ...fields }));

  const existing = await db.send(new GetCommand({ TableName: JOBS_TABLE, Key: { jobId } }));
  const job = existing.Item;
  if (!job) {
    log({ outcome: "dropped_missing_job" });
    return;
  }
  if (job.status === "succeeded" || job.status === "failed") {
    log({ outcome: "skipped_already_terminal", status: job.status });
    return;
  }

  const startedAt = Date.now();
  try {
    const client = await getClient();
    const extractedFacts = await loadExtractedFacts(job.sourceExtractionJobIds);
    const userTurn = buildUserTurn({
      companyName: job.input.companyName,
      extractedFacts,
      truncateChars: FACTS_TRUNCATE_CHARS,
    });

    const { messages, iterations, totalTokens: researchTokens, searchCount } = await runResearchPhase({
      client,
      model: MODEL,
      maxTokens: MAX_TOKENS,
      userTurn,
      maxIterations: MAX_ITERATIONS,
      maxTotalTokens: MAX_TOTAL_TOKENS,
      maxSearchUses: MAX_SEARCH_USES,
    });

    const verifyResponse = await runVerifyPhase({ client, model: MODEL, maxTokens: MAX_TOKENS, messages });

    if (verifyResponse.stop_reason === "refusal") {
      throw new Error("Claude declined to finalize this research report (safety refusal)");
    }

    const inputTokens = researchTokens + (verifyResponse.usage?.input_tokens || 0);
    const outputTokens = verifyResponse.usage?.output_tokens || 0;
    const estimatedCostUsd = estimateCostUsd(inputTokens, outputTokens) + searchCount * WEB_SEARCH_PRICE_PER_SEARCH;

    const textBlock = verifyResponse.content.find((block) => block.type === "text");
    const result = JSON.parse(textBlock.text);

    await markStatus(jobId, {
      status: "succeeded",
      result,
      inputTokens,
      outputTokens,
      webSearchCount: searchCount,
      estimatedCostUsd,
    });

    log({
      outcome: "succeeded",
      researchIterations: iterations,
      webSearchCount: searchCount,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      latencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    log({ outcome: "failed", error: err.message, latencyMs: Date.now() - startedAt, isFinalAttempt });

    if (isFinalAttempt) {
      // Last attempt before SQS moves this message to the DLQ — mark the
      // job failed now so GET /jobs/{id} reflects reality promptly rather
      // than waiting on DLQ observability. Research jobs have no children,
      // so there's no fan-in to unblock here (unlike extractWorker).
      await markStatus(jobId, { status: "failed", error: err.message });
    }

    throw err; // let SQS redeliver (or move to DLQ on the final attempt)
  }
}

exports.handler = async (event) => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};
