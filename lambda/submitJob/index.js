const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { randomUUID } = require("crypto");

const ddb = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(ddb);
const sqs = new SQSClient({});

const JOBS_TABLE = process.env.JOBS_TABLE;
const EXTRACTION_QUEUE_URL = process.env.EXTRACTION_QUEUE_URL;
const RESEARCH_QUEUE_URL = process.env.RESEARCH_QUEUE_URL;

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function putJob(item) {
  await db.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: item,
    ConditionExpression: "attribute_not_exists(jobId)",
  }));
}

async function enqueue(queueUrl, jobId) {
  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ jobId }),
  }));
}

function baseJob({ jobId, type, status, input, createdAt }) {
  return { jobId, type, status, input, createdAt, updatedAt: createdAt };
}

// Creates one extraction job record per source document, each tagged with
// parentResearchJobId so extractWorker knows which research job's fan-in
// counter to decrement on completion (see README's Fan-out/fan-in section).
async function createSourceExtractionJobs(sourceDocuments, jobIds, researchJobId, createdAt) {
  for (let i = 0; i < sourceDocuments.length; i++) {
    const jobId = jobIds[i];
    await putJob({
      ...baseJob({ jobId, type: "extraction", status: "queued", input: sourceDocuments[i], createdAt }),
      parentResearchJobId: researchJobId,
    });
    await enqueue(EXTRACTION_QUEUE_URL, jobId);
  }
}

async function submitExtraction(input) {
  if (!input || typeof input.documentText !== "string" || !input.documentText.trim()) {
    return response(400, { error: "input.documentText is required" });
  }

  const jobId = randomUUID();
  const createdAt = new Date().toISOString();

  await putJob(baseJob({ jobId, type: "extraction", status: "queued", input, createdAt }));
  await enqueue(EXTRACTION_QUEUE_URL, jobId);

  return response(201, { jobId, type: "extraction", status: "queued", createdAt });
}

async function submitResearch(input, sourceDocuments) {
  if (!input || typeof input.companyName !== "string" || !input.companyName.trim()) {
    return response(400, { error: "input.companyName is required" });
  }
  if (sourceDocuments !== undefined && !Array.isArray(sourceDocuments)) {
    return response(400, { error: "sourceDocuments must be an array when provided" });
  }

  const jobId = randomUUID();
  const createdAt = new Date().toISOString();
  const docs = sourceDocuments || [];

  if (docs.length === 0) {
    // No source documents to extract first — go straight to research-queue.
    await putJob(baseJob({ jobId, type: "research", status: "queued", input, createdAt }));
    await enqueue(RESEARCH_QUEUE_URL, jobId);
    return response(201, { jobId, type: "research", status: "queued", createdAt });
  }

  // Precompute the child jobIds so the parent record is written correctly
  // the first time (no follow-up UpdateItem needed). Written BEFORE any
  // extraction job is enqueued, so an extraction job that completes
  // unusually fast never races ahead of its own parent record existing.
  const sourceExtractionJobIds = docs.map(() => randomUUID());

  await putJob({
    ...baseJob({ jobId, type: "research", status: "waiting", input, createdAt }),
    pendingExtractionCount: docs.length,
    sourceExtractionJobIds,
  });

  await createSourceExtractionJobs(docs, sourceExtractionJobIds, jobId, createdAt);

  return response(201, {
    jobId,
    type: "research",
    status: "waiting",
    createdAt,
    sourceExtractionJobIds,
  });
}

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return response(400, { error: "Invalid JSON" }); }

  const { type, input, sourceDocuments } = body;

  if (type === "extraction") return submitExtraction(input);
  if (type === "research") return submitResearch(input, sourceDocuments);

  return response(400, { error: 'type must be "extraction" or "research"' });
};
