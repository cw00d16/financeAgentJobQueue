const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");

const ddb = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(ddb);
const JOBS_TABLE = process.env.JOBS_TABLE;

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const jobId = event.pathParameters?.id;
  if (!jobId) return response(400, { error: "Missing job id" });

  const result = await db.send(new GetCommand({
    TableName: JOBS_TABLE,
    Key: { jobId },
  }));

  if (!result.Item) return response(404, { error: "Job not found" });

  return response(200, result.Item);
};
