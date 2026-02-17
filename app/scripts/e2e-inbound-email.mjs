import process from "node:process";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

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

function normalizeEmail(value) {
  const candidate = String(value ?? "")
    .trim()
    .toLowerCase();
  const match = candidate.match(/[a-z0-9._%+-]+@[a-z0-9.-]+/);
  return match ? match[0] : candidate.replace(/[<>]/g, "").trim();
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

const fromEmail = normalizeEmail(args.from ?? process.env.E2E_FROM_EMAIL);
const toEmail = normalizeEmail(args.to ?? process.env.E2E_TO_EMAIL ?? "agent@agent.letsconnect.ai");
const traceTableName = String(args["trace-table"] ?? process.env.TRACE_TABLE_NAME ?? "").trim();
const sendRegion = String(args["send-region"] ?? process.env.E2E_SEND_REGION ?? "us-east-1").trim();
const traceRegion = String(args["trace-region"] ?? process.env.E2E_TRACE_REGION ?? "us-east-1").trim();
const expectedResponseMode = String(args["expected-response-mode"] ?? "send").trim().toLowerCase();
const timeoutSeconds = Number.parseInt(args["timeout-seconds"] ?? "180", 10);
const pollSeconds = Number.parseInt(args["poll-seconds"] ?? "5", 10);

if (!fromEmail || !toEmail || !traceTableName) {
  fail(
    "Usage: node scripts/e2e-inbound-email.mjs --from <verified-sender> --to <inbound-recipient> --trace-table <TraceTableName> [--send-region us-east-1] [--trace-region us-east-1]"
  );
}

const fromDomain = fromEmail.split("@")[1] ?? "unknown";
const subject = args.subject ?? `E2E inbound spike ${new Date().toISOString()}`;
const body =
  args.body ??
  "Timezone: America/Los_Angeles\nI can do 2026-02-19T10:00:00-08:00 to 2026-02-19T11:00:00-08:00";

const sesClient = new SESv2Client({ region: sendRegion });
const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: traceRegion }));

const startIso = new Date().toISOString();

const sendResponse = await sesClient.send(
  new SendEmailCommand({
    FromEmailAddress: fromEmail,
    Destination: {
      ToAddresses: [toEmail]
    },
    Content: {
      Simple: {
        Subject: { Data: subject },
        Body: {
          Text: { Data: body }
        }
      }
    }
  })
);

const deadlineMs = Date.now() + timeoutSeconds * 1000;
let matchedTrace = null;

while (Date.now() <= deadlineMs) {
  const scanResponse = await ddbDocClient.send(
    new ScanCommand({
      TableName: traceTableName,
      FilterExpression: "#fromDomain = :fromDomain AND #createdAt >= :startIso",
      ExpressionAttributeNames: {
        "#fromDomain": "fromDomain",
        "#createdAt": "createdAt"
      },
      ExpressionAttributeValues: {
        ":fromDomain": fromDomain,
        ":startIso": startIso
      }
    })
  );

  const items = scanResponse.Items ?? [];
  if (items.length > 0) {
    items.sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));
    matchedTrace = items[0];
    break;
  }

  await sleep(pollSeconds * 1000);
}

if (!matchedTrace) {
  fail(
    `No trace found for fromDomain=${fromDomain} after ${timeoutSeconds}s. SES MessageId=${sendResponse.MessageId ?? "unknown"}`
  );
}

if (matchedTrace.status !== "completed") {
  fail(`Trace status is not completed. requestId=${matchedTrace.requestId} status=${matchedTrace.status}`);
}

if (String(matchedTrace.responseMode ?? "").toLowerCase() !== expectedResponseMode) {
  fail(
    `Trace responseMode mismatch. requestId=${matchedTrace.requestId} expected=${expectedResponseMode} actual=${matchedTrace.responseMode}`
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      sesMessageId: sendResponse.MessageId ?? null,
      requestId: matchedTrace.requestId ?? null,
      responseId: matchedTrace.responseId ?? null,
      status: matchedTrace.status ?? null,
      responseMode: matchedTrace.responseMode ?? null,
      llmStatus: matchedTrace.llmStatus ?? null,
      fromDomain: matchedTrace.fromDomain ?? null,
      createdAt: matchedTrace.createdAt ?? null
    },
    null,
    2
  )}\n`
);
