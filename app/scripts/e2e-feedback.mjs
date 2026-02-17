import process from "node:process";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

function parseArgs(argv) {
  const parsed = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }

    parsed[key] = value;
    i += 1;
  }

  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv);

const apiBase = String(args["api-base"] ?? process.env.SPIKE_API_BASE ?? "").trim().replace(/\/+$/, "");
const requestId = String(args["request-id"] ?? "").trim();
const responseId = String(args["response-id"] ?? "").trim();
const traceTableName = String(args["trace-table"] ?? process.env.TRACE_TABLE_NAME ?? "").trim();
const traceRegion = String(args["trace-region"] ?? process.env.E2E_TRACE_REGION ?? "us-east-1").trim();
const feedbackType = String(args["feedback-type"] ?? "odd").trim().toLowerCase();
const feedbackReason = String(args["feedback-reason"] ?? "tone_quality").trim().toLowerCase();
const feedbackSource = String(args["feedback-source"] ?? "client").trim().toLowerCase();
const timeoutSeconds = Number.parseInt(args["timeout-seconds"] ?? "60", 10);

if (!apiBase || !requestId || !responseId || !traceTableName) {
  fail(
    "Usage: node scripts/e2e-feedback.mjs --api-base <https://.../dev> --request-id <id> --response-id <id> --trace-table <TraceTableName>"
  );
}

const feedbackUrl = `${apiBase}/spike/feedback`;
const response = await fetch(feedbackUrl, {
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify({
    requestId,
    responseId,
    feedbackType,
    feedbackReason,
    feedbackSource
  })
});

if (!response.ok) {
  fail(`Feedback endpoint failed: ${response.status} ${await response.text()}`);
}

const feedbackPayload = await response.json();
if (!feedbackPayload.feedbackRecorded) {
  fail("Feedback endpoint response did not report feedbackRecorded=true");
}

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: traceRegion }));
const deadlineMs = Date.now() + timeoutSeconds * 1000;
let traceItem = null;

while (Date.now() <= deadlineMs) {
  const getResponse = await ddbDocClient.send(
    new GetCommand({
      TableName: traceTableName,
      Key: {
        requestId
      }
    })
  );

  traceItem = getResponse.Item ?? null;
  if (
    traceItem &&
    traceItem.responseId === responseId &&
    traceItem.feedbackType === feedbackType &&
    traceItem.feedbackReason === feedbackReason &&
    traceItem.feedbackSource === feedbackSource
  ) {
    break;
  }

  traceItem = null;
  await sleep(3000);
}

if (!traceItem) {
  fail("Feedback was not observed in trace table before timeout");
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      requestId,
      responseId,
      feedbackType: traceItem.feedbackType,
      feedbackReason: traceItem.feedbackReason,
      feedbackSource: traceItem.feedbackSource,
      feedbackCount: traceItem.feedbackCount ?? null,
      feedbackUpdatedAt: traceItem.feedbackUpdatedAt ?? null
    },
    null,
    2
  )}\n`
);
