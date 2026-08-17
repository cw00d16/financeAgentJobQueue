const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const Anthropic = require("@anthropic-ai/sdk");
const { buildUserTurn, callClaude } = require("./extract");

const ddb = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(ddb);
const sqs = new SQSClient({});
const secretsClient = new SecretsManagerClient({});

const JOBS_TABLE = process.env.JOBS_TABLE;
const RESEARCH_QUEUE_URL = process.env.RESEARCH_QUEUE_URL;
const ANTHROPIC_SECRET_ARN = process.env.ANTHROPIC_SECRET_ARN;
const MAX_RECEIVE_COUNT = Number(process.env.MAX_RECEIVE_COUNT || 3);
// Haiku 4.5: cheapest model that clears the bar for single-call structured
// extraction, per README's "keeping this cheap" section.
const MODEL = process.env.MODEL || "claude-haiku-4-5";
const MAX_TOKENS = Number(process.env.EXTRACT_MAX_TOKENS || 2048);
// Defensive cap, not a normal-path limit — DynamoDB's own 400KB item size
// already bounds documentText in practice. This is the same "truncate
// defensively" belt-and-suspenders pattern the README calls for in the
// eval harness, applied to production input too.
const DOCUMENT_TRUNCATE_CHARS = Number(process.env.DOCUMENT_TRUNCATE_CHARS || 200000);

// Haiku 4.5 list pricing per million tokens — keep in sync with
// infrastructure/observability.tf's haiku_input_price_per_mtok /
// haiku_output_price_per_mtok if the model or pricing ever changes.
const INPUT_PRICE_PER_MTOK = 1;
const OUTPUT_PRICE_PER_MTOK = 5;

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

// Aliases every attribute name (not just "status") since several — status,
// result, error — collide with DynamoDB reserved words.
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

// Atomically decrements the parent research job's fan-in counter. If this
// decrement is the one that brings the count to zero, this invocation
// (and only this one — DynamoDB serializes updates to a single item) is
// responsible for moving the parent from "waiting" to "queued" and
// enqueuing it onto research-queue. See README's Fan-out/fan-in section.
async function decrementParentFanIn(parentResearchJobId) {
  let decremented;
  try {
    decremented = await db.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId: parentResearchJobId },
      UpdateExpression: "SET pendingExtractionCount = pendingExtractionCount - :one, updatedAt = :updatedAt",
      ConditionExpression: "pendingExtractionCount > :zero",
      ExpressionAttributeValues: { ":one": 1, ":zero": 0, ":updatedAt": new Date().toISOString() },
      ReturnValues: "UPDATED_NEW",
    }));
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return; // already at zero — another invocation is handling it
    throw err;
  }

  if (decremented.Attributes.pendingExtractionCount !== 0) return;

  try {
    await db.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId: parentResearchJobId },
      UpdateExpression: "SET #status = :queued, updatedAt = :updatedAt",
      ConditionExpression: "#status = :waiting",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":queued": "queued", ":waiting": "waiting", ":updatedAt": new Date().toISOString() },
    }));
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return; // already flipped — no-op
    throw err;
  }

  await sqs.send(new SendMessageCommand({
    QueueUrl: RESEARCH_QUEUE_URL,
    MessageBody: JSON.stringify({ jobId: parentResearchJobId }),
  }));
}

async function processRecord(record) {
  const { jobId } = JSON.parse(record.body);
  const receiveCount = Number(record.attributes?.ApproximateReceiveCount || 1);
  const isFinalAttempt = receiveCount >= MAX_RECEIVE_COUNT;
  const log = (fields) => console.log(JSON.stringify({ event: "job_processed", jobId, type: "extraction", ...fields }));

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
    const userTurn = buildUserTurn({
      documentText: job.input.documentText,
      documentType: job.input.documentType,
      truncateChars: DOCUMENT_TRUNCATE_CHARS,
    });

    const response = await callClaude({ client, model: MODEL, maxTokens: MAX_TOKENS, userTurn });

    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    if (response.stop_reason === "refusal") {
      throw new Error("Claude declined to process this document (safety refusal)");
    }

    const textBlock = response.content.find((block) => block.type === "text");
    const result = JSON.parse(textBlock.text);

    await markStatus(jobId, {
      status: "succeeded",
      result,
      inputTokens,
      outputTokens,
      estimatedCostUsd: estimateCostUsd(inputTokens, outputTokens),
    });

    if (job.parentResearchJobId) {
      await decrementParentFanIn(job.parentResearchJobId);
    }

    log({
      outcome: "succeeded",
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    log({ outcome: "failed", error: err.message, latencyMs: Date.now() - startedAt, isFinalAttempt });

    if (isFinalAttempt) {
      // Last attempt before SQS moves this message to the DLQ — mark the
      // job failed now (rather than waiting on DLQ observability) so
      // GET /jobs/{id} reflects reality promptly, and unblock the parent
      // research job's fan-in so a permanently-failed source extraction
      // doesn't leave it stuck in "waiting" forever.
      await markStatus(jobId, { status: "failed", error: err.message });
      if (job.parentResearchJobId) {
        await decrementParentFanIn(job.parentResearchJobId);
      }
    }

    throw err; // let SQS redeliver (or move to DLQ on the final attempt)
  }
}

exports.handler = async (event) => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};
