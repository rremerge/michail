import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { createHandler, processSchedulingEmail, processSchedulingFeedback } from "../src/handler.js";

const baseEnv = {
  TRACE_TABLE_NAME: "TraceTable",
  RESPONSE_MODE: "log",
  CALENDAR_MODE: "mock",
  HOST_TIMEZONE: "America/Los_Angeles",
  ADVISING_DAYS: "Tue,Wed",
  SEARCH_DAYS: "7",
  MAX_SUGGESTIONS: "3"
};

test("processSchedulingEmail handles e2e request with metadata-only trace", async () => {
  const traceItems = [];
  const sentMessages = [];

  const deps = {
    async getSecretString() {
      return JSON.stringify({});
    },
    async writeTrace(_tableName, item) {
      traceItems.push(item);
    },
    async sendResponseEmail(message) {
      sentMessages.push(message);
    }
  };

  const payload = {
    fromEmail: "client@example.com",
    subject: "Need 30 min chat",
    body: "Timezone: America/New_York",
    mockBusyIntervals: [
      {
        startIso: "2026-03-03T17:00:00Z",
        endIso: "2026-03-03T17:30:00Z"
      }
    ]
  };

  const result = await processSchedulingEmail({
    payload,
    env: baseEnv,
    deps,
    now: () => Date.parse("2026-03-03T00:00:00Z")
  });

  assert.equal(result.http.statusCode, 200);
  const response = JSON.parse(result.http.body);
  assert.equal(response.deliveryStatus, "logged");
  assert.equal(response.suggestionCount, 3);
  assert.equal(sentMessages.length, 0);

  assert.equal(traceItems.length, 1);
  const trace = traceItems[0];
  assert.equal(trace.status, "completed");
  assert.equal(trace.fromDomain, "example.com");
  assert.equal(trace.channel, "email");
  assert.equal(trace.suggestionCount, 3);
  assert.equal(trace.responseMode, "log");

  const traceJson = JSON.stringify(trace);
  assert.equal(traceJson.includes("client@example.com"), false);
  assert.equal(traceJson.includes("Need 30 min chat"), false);
});

test("processSchedulingEmail respects requested windows from natural language", async () => {
  const deps = {
    async getSecretString() {
      return "";
    },
    async writeTrace() {},
    async sendResponseEmail() {}
  };

  const result = await processSchedulingEmail({
    payload: {
      fromEmail: "client@example.com",
      subject: "Scheduling request",
      body: "Could we do Wednesday between 2pm and 4pm? Timezone: America/Los_Angeles"
    },
    env: baseEnv,
    deps,
    now: () => Date.parse("2026-03-02T18:00:00Z")
  });

  assert.equal(result.http.statusCode, 200);
  const response = JSON.parse(result.http.body);
  assert.equal(response.suggestionCount, 3);

  for (const suggestion of response.suggestions) {
    const hostStart = DateTime.fromISO(suggestion.startIsoHost);
    assert.equal(hostStart.weekday, 3); // Wednesday
    assert.equal(hostStart.hour >= 14 && hostStart.hour < 16, true);
  }
});

test("processSchedulingEmail uses LLM-extracted windows when parser has no windows", async () => {
  const traceItems = [];
  const deps = {
    async getSecretString(secretArn) {
      assert.equal(secretArn, "arn:llm-secret");
      return JSON.stringify({
        api_key: "test-openai-key",
        model: "gpt-5.2"
      });
    },
    async extractSchedulingIntentWithLlm() {
      return {
        requestedWindows: [
          {
            startIso: "2026-03-04T22:00:00.000Z",
            endIso: "2026-03-05T00:00:00.000Z"
          }
        ],
        clientTimezone: "America/Los_Angeles",
        confidence: 0.95
      };
    },
    async writeTrace(_tableName, item) {
      traceItems.push(item);
    },
    async sendResponseEmail() {}
  };

  const env = {
    ...baseEnv,
    INTENT_EXTRACTION_MODE: "llm_hybrid",
    LLM_PROVIDER_SECRET_ARN: "arn:llm-secret"
  };

  const result = await processSchedulingEmail({
    payload: {
      fromEmail: "client@example.com",
      subject: "Scheduling",
      body: "Post-lunch next week works for me."
    },
    env,
    deps,
    now: () => Date.parse("2026-03-02T18:00:00Z")
  });

  assert.equal(result.http.statusCode, 200);
  const response = JSON.parse(result.http.body);
  assert.equal(response.suggestionCount, 3);

  for (const suggestion of response.suggestions) {
    const hostStart = DateTime.fromISO(suggestion.startIsoHost);
    assert.equal(hostStart.weekday, 3);
    assert.equal(hostStart.hour >= 14 && hostStart.hour < 16, true);
  }

  assert.equal(traceItems[0].intentSource, "llm");
  assert.equal(traceItems[0].intentLlmStatus, "ok");
  assert.equal(traceItems[0].requestedWindowCount, 1);
});

test("processSchedulingEmail keeps parser windows when LLM confidence is low", async () => {
  const traceItems = [];
  const deps = {
    async getSecretString() {
      return JSON.stringify({
        api_key: "test-openai-key",
        model: "gpt-5.2"
      });
    },
    async extractSchedulingIntentWithLlm() {
      return {
        requestedWindows: [
          {
            startIso: "2026-03-04T22:00:00.000Z",
            endIso: "2026-03-05T00:00:00.000Z"
          }
        ],
        clientTimezone: "America/Los_Angeles",
        confidence: 0.2
      };
    },
    async writeTrace(_tableName, item) {
      traceItems.push(item);
    },
    async sendResponseEmail() {}
  };

  const env = {
    ...baseEnv,
    INTENT_EXTRACTION_MODE: "llm_hybrid",
    LLM_PROVIDER_SECRET_ARN: "arn:llm-secret"
  };

  const result = await processSchedulingEmail({
    payload: {
      fromEmail: "client@example.com",
      subject: "Scheduling",
      body: "Timezone: America/Los_Angeles. I can do Tuesday between 9am and 11am."
    },
    env,
    deps,
    now: () => Date.parse("2026-03-02T18:00:00Z")
  });

  assert.equal(result.http.statusCode, 200);
  const response = JSON.parse(result.http.body);
  assert.equal(response.suggestionCount, 3);

  for (const suggestion of response.suggestions) {
    const hostStart = DateTime.fromISO(suggestion.startIsoHost);
    assert.equal(hostStart.weekday, 2);
    assert.equal(hostStart.hour >= 9 && hostStart.hour < 11, true);
  }

  assert.equal(traceItems[0].intentSource, "parser");
  assert.equal(traceItems[0].intentLlmStatus, "ok");
  assert.equal(traceItems[0].requestedWindowCount, 1);
});

test("processSchedulingEmail returns 400 when fromEmail is missing", async () => {
  const deps = {
    async getSecretString() {
      return "";
    },
    async writeTrace() {},
    async sendResponseEmail() {}
  };

  const result = await processSchedulingEmail({
    payload: {
      subject: "No sender"
    },
    env: baseEnv,
    deps
  });

  assert.equal(result.http.statusCode, 400);
  assert.match(result.http.body, /fromEmail is required/);
});

test("processSchedulingEmail sends email when RESPONSE_MODE=send", async () => {
  const sentMessages = [];

  const deps = {
    async getSecretString() {
      return "";
    },
    async writeTrace() {},
    async sendResponseEmail(message) {
      sentMessages.push(message);
    }
  };

  const env = {
    ...baseEnv,
    RESPONSE_MODE: "send",
    SENDER_EMAIL: "manoj@example.com"
  };

  const result = await processSchedulingEmail({
    payload: {
      fromEmail: "client@example.com",
      subject: "Chat"
    },
    env,
    deps,
    now: () => Date.parse("2026-03-03T00:00:00Z")
  });

  assert.equal(result.http.statusCode, 200);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].senderEmail, "manoj@example.com");
  assert.equal(sentMessages[0].recipientEmail, "client@example.com");
});

test("processSchedulingEmail normalizes sender address and domain from formatted header", async () => {
  const traceItems = [];
  const sentMessages = [];
  const deps = {
    async getSecretString() {
      return "";
    },
    async writeTrace(_tableName, item) {
      traceItems.push(item);
    },
    async sendResponseEmail(message) {
      sentMessages.push(message);
    }
  };

  const env = {
    ...baseEnv,
    RESPONSE_MODE: "send",
    SENDER_EMAIL: "manoj@example.com"
  };

  const result = await processSchedulingEmail({
    payload: {
      fromEmail: "\"Titoneeda\" <titoneeda@gmail.com>",
      subject: "Chat"
    },
    env,
    deps,
    now: () => Date.parse("2026-03-03T00:00:00Z")
  });

  assert.equal(result.http.statusCode, 200);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].recipientEmail, "titoneeda@gmail.com");
  assert.equal(traceItems[0].fromDomain, "gmail.com");
});

test("processSchedulingEmail loads body from transient mail store and deletes raw object", async () => {
  const traceItems = [];
  const calls = [];
  const deps = {
    async getRawEmailObject(location) {
      calls.push(["get", location]);
      return [
        "From: Titoneeda <titoneeda@gmail.com>",
        "Subject: Need appointment",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Timezone: America/Los_Angeles",
        "I can do 2026-03-03T10:00:00-08:00 to 2026-03-03T12:00:00-08:00"
      ].join("\n");
    },
    async deleteRawEmailObject(location) {
      calls.push(["delete", location]);
    },
    async writeTrace(_tableName, item) {
      traceItems.push(item);
    },
    async sendResponseEmail() {}
  };

  const env = {
    ...baseEnv,
    RAW_EMAIL_BUCKET: "mail-store-bucket",
    RAW_EMAIL_BUCKET_REGION: "us-east-1",
    RAW_EMAIL_OBJECT_PREFIX: "raw/"
  };

  const result = await processSchedulingEmail({
    payload: {
      fromEmail: "Titoneeda <titoneeda@gmail.com>",
      subject: "Need appointment",
      body: "",
      ses: {
        messageId: "message-123",
        receipt: {}
      }
    },
    env,
    deps,
    now: () => Date.parse("2026-03-03T00:00:00Z")
  });

  assert.equal(result.http.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "get");
  assert.deepEqual(calls[0][1], {
    bucket: "mail-store-bucket",
    key: "raw/message-123",
    region: "us-east-1"
  });
  assert.equal(calls[1][0], "delete");
  assert.deepEqual(calls[1][1], calls[0][1]);
  assert.equal(traceItems[0].bodySource, "mail_store");
});

test("processSchedulingEmail parses html-only MIME bodies from transient mail store", async () => {
  const traceItems = [];
  const deps = {
    async getRawEmailObject() {
      return [
        "From: Titoneeda <titoneeda@gmail.com>",
        "Subject: Appointment request",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><body>",
        "<p>Timezone: America/Los_Angeles</p>",
        "<p>I need 45 minutes.</p>",
        "<p>I can do 2026-03-03T10:00:00-08:00 to 2026-03-03T12:00:00-08:00</p>",
        "</body></html>"
      ].join("\n");
    },
    async deleteRawEmailObject() {},
    async writeTrace(_tableName, item) {
      traceItems.push(item);
    },
    async sendResponseEmail() {}
  };

  const env = {
    ...baseEnv,
    RAW_EMAIL_BUCKET: "mail-store-bucket",
    RAW_EMAIL_BUCKET_REGION: "us-east-1",
    RAW_EMAIL_OBJECT_PREFIX: "raw/"
  };

  const result = await processSchedulingEmail({
    payload: {
      fromEmail: "titoneeda@gmail.com",
      subject: "Need appointment",
      body: "",
      ses: {
        messageId: "message-html",
        receipt: {}
      }
    },
    env,
    deps,
    now: () => Date.parse("2026-03-03T00:00:00Z")
  });

  assert.equal(result.http.statusCode, 200);
  assert.equal(traceItems[0].bodySource, "mail_store");
  assert.equal(traceItems[0].durationMinutes, 45);
});

test("processSchedulingEmail uses SES receipt mailStore location when provided", async () => {
  const calls = [];
  const deps = {
    async getRawEmailObject(location) {
      calls.push(location);
      return [
        "From: Titoneeda <titoneeda@gmail.com>",
        "Subject: Appointment request",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Timezone: America/Los_Angeles",
        "I need 30 minutes."
      ].join("\n");
    },
    async deleteRawEmailObject() {},
    async writeTrace() {},
    async sendResponseEmail() {}
  };

  const result = await processSchedulingEmail({
    payload: {
      fromEmail: "titoneeda@gmail.com",
      subject: "Need appointment",
      ses: {
        messageId: "ignored-message-id",
        receipt: {
          mailStore: {
            bucket: "receipt-mail-bucket",
            key: "raw/custom-object-key",
            region: "us-east-1"
          }
        }
      }
    },
    env: baseEnv,
    deps,
    now: () => Date.parse("2026-03-03T00:00:00Z")
  });

  assert.equal(result.http.statusCode, 200);
  assert.deepEqual(calls[0], {
    bucket: "receipt-mail-bucket",
    key: "raw/custom-object-key",
    region: "us-east-1"
  });
});

test("processSchedulingEmail continues when transient mail store is unavailable", async () => {
  const traceItems = [];
  const deps = {
    async getRawEmailObject() {
      throw new Error("s3 unavailable");
    },
    async deleteRawEmailObject() {},
    async writeTrace(_tableName, item) {
      traceItems.push(item);
    },
    async sendResponseEmail() {}
  };

  const env = {
    ...baseEnv,
    RAW_EMAIL_BUCKET: "mail-store-bucket",
    RAW_EMAIL_BUCKET_REGION: "us-east-1",
    RAW_EMAIL_OBJECT_PREFIX: "raw/"
  };

  const result = await processSchedulingEmail({
    payload: {
      fromEmail: "titoneeda@gmail.com",
      subject: "Need appointment",
      ses: {
        messageId: "message-456",
        receipt: {}
      }
    },
    env,
    deps,
    now: () => Date.parse("2026-03-03T00:00:00Z")
  });

  assert.equal(result.http.statusCode, 200);
  assert.equal(traceItems[0].bodySource, "mail_store_unavailable");
});

test("processSchedulingEmail uses primary connection in CALENDAR_MODE=connection", async () => {
  const traceItems = [];
  const deps = {
    async getPrimaryConnection(tableName, advisorId) {
      assert.equal(tableName, "ConnectionsTable");
      assert.equal(advisorId, "manoj");
      return {
        provider: "mock",
        status: "connected",
        isPrimary: true,
        updatedAt: "2026-03-03T00:00:00Z"
      };
    },
    async getSecretString() {
      return "";
    },
    async lookupBusyIntervals() {
      return [];
    },
    async writeTrace(_tableName, item) {
      traceItems.push(item);
    },
    async sendResponseEmail() {}
  };

  const env = {
    ...baseEnv,
    CALENDAR_MODE: "connection",
    CONNECTIONS_TABLE_NAME: "ConnectionsTable",
    ADVISOR_ID: "manoj"
  };

  const result = await processSchedulingEmail({
    payload: {
      fromEmail: "client@example.com",
      subject: "Chat"
    },
    env,
    deps,
    now: () => Date.parse("2026-03-03T00:00:00Z")
  });

  assert.equal(result.http.statusCode, 200);
  assert.equal(traceItems.length, 1);
  assert.equal(traceItems[0].calendarMode, "connection");
});

test("processSchedulingEmail uses LLM draft when LLM_MODE=openai", async () => {
  const sentMessages = [];
  const traceItems = [];

  const deps = {
    async getSecretString(secretArn) {
      assert.equal(secretArn, "arn:llm-secret");
      return JSON.stringify({
        api_key: "test-openai-key",
        model: "gpt-5.2"
      });
    },
    async draftResponseWithLlm() {
      return {
        subject: "Re: Chat request",
        bodyText: "LLM drafted body"
      };
    },
    async writeTrace(_tableName, item) {
      traceItems.push(item);
    },
    async sendResponseEmail(message) {
      sentMessages.push(message);
    }
  };

  const env = {
    ...baseEnv,
    RESPONSE_MODE: "send",
    SENDER_EMAIL: "manoj@example.com",
    LLM_MODE: "openai",
    LLM_PROVIDER_SECRET_ARN: "arn:llm-secret"
  };

  const result = await processSchedulingEmail({
    payload: {
      fromEmail: "client@example.com",
      subject: "Chat"
    },
    env,
    deps,
    now: () => Date.parse("2026-03-03T00:00:00Z")
  });

  assert.equal(result.http.statusCode, 200);
  const response = JSON.parse(result.http.body);
  assert.equal(response.llmStatus, "ok");
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].subject, "Re: Chat request");
  assert.match(sentMessages[0].bodyText, /LLM drafted body/);
  assert.match(sentMessages[0].bodyText, /Suggested options in local time:/);
  assert.match(sentMessages[0].bodyText, /\bTue\b|\bWed\b|\bThu\b|\bFri\b|\bSat\b|\bSun\b|\bMon\b/);
  assert.equal(traceItems[0].llmStatus, "ok");
  assert.equal(traceItems[0].llmMode, "openai");
});

test("processSchedulingEmail falls back to template response when LLM draft fails", async () => {
  const sentMessages = [];
  const traceItems = [];

  const deps = {
    async getSecretString() {
      return JSON.stringify({
        api_key: "test-openai-key",
        model: "gpt-5.2"
      });
    },
    async draftResponseWithLlm() {
      throw new Error("simulated llm error");
    },
    async writeTrace(_tableName, item) {
      traceItems.push(item);
    },
    async sendResponseEmail(message) {
      sentMessages.push(message);
    }
  };

  const env = {
    ...baseEnv,
    RESPONSE_MODE: "send",
    SENDER_EMAIL: "manoj@example.com",
    LLM_MODE: "openai",
    LLM_PROVIDER_SECRET_ARN: "arn:llm-secret"
  };

  const result = await processSchedulingEmail({
    payload: {
      fromEmail: "client@example.com",
      subject: "Chat"
    },
    env,
    deps,
    now: () => Date.parse("2026-03-03T00:00:00Z")
  });

  assert.equal(result.http.statusCode, 200);
  const response = JSON.parse(result.http.body);
  assert.equal(response.llmStatus, "fallback");
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].subject, /^Re:/);
  assert.match(sentMessages[0].bodyText, /Thanks for reaching out/);
  assert.equal(traceItems[0].llmStatus, "fallback");
  assert.equal(traceItems[0].llmMode, "openai");
});

test("processSchedulingFeedback records metadata-only feedback", async () => {
  const updates = [];
  const deps = {
    async updateTraceFeedback(_tableName, update) {
      updates.push(update);
      return { requestId: update.requestId, responseId: update.responseId };
    }
  };

  const result = await processSchedulingFeedback({
    payload: {
      requestId: "123e4567-e89b-12d3-a456-426614174000",
      responseId: "123e4567-e89b-12d3-a456-426614174001",
      feedbackType: "incorrect",
      feedbackReason: "timezone_issue",
      feedbackSource: "client"
    },
    env: baseEnv,
    deps,
    now: () => Date.parse("2026-03-03T00:00:00Z")
  });

  assert.equal(result.http.statusCode, 200);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].feedbackType, "incorrect");
  assert.equal(updates[0].feedbackReason, "timezone_issue");
  assert.equal(updates[0].feedbackSource, "client");
});

test("processSchedulingFeedback returns 404 when trace is not found", async () => {
  const deps = {
    async updateTraceFeedback() {
      return null;
    }
  };

  const result = await processSchedulingFeedback({
    payload: {
      requestId: "123e4567-e89b-12d3-a456-426614174000",
      responseId: "123e4567-e89b-12d3-a456-426614174001",
      feedbackType: "odd"
    },
    env: baseEnv,
    deps
  });

  assert.equal(result.http.statusCode, 404);
  assert.match(result.http.body, /were not found/);
});

test("createHandler routes /spike/feedback requests to feedback flow", async () => {
  let updateCalled = false;
  const handler = createHandler({
    async updateTraceFeedback() {
      updateCalled = true;
      return {
        requestId: "123e4567-e89b-12d3-a456-426614174000",
        responseId: "123e4567-e89b-12d3-a456-426614174001"
      };
    }
  });

  const previousTraceTable = process.env.TRACE_TABLE_NAME;
  process.env.TRACE_TABLE_NAME = "TraceTable";

  try {
    const response = await handler({
      version: "2.0",
      requestContext: {
        stage: "dev",
        http: { method: "POST" }
      },
      rawPath: "/dev/spike/feedback",
      body: JSON.stringify({
        requestId: "123e4567-e89b-12d3-a456-426614174000",
        responseId: "123e4567-e89b-12d3-a456-426614174001",
        feedbackType: "helpful",
        feedbackReason: "other",
        feedbackSource: "client"
      })
    });

    assert.equal(response.statusCode, 200);
    assert.equal(updateCalled, true);
    const payload = JSON.parse(response.body);
    assert.equal(payload.feedbackRecorded, true);
    assert.equal(payload.feedbackType, "helpful");
  } finally {
    if (previousTraceTable === undefined) {
      delete process.env.TRACE_TABLE_NAME;
    } else {
      process.env.TRACE_TABLE_NAME = previousTraceTable;
    }
  }
});

test("createHandler normalizes SES from header before processing", async () => {
  const traceItems = [];
  const sentMessages = [];
  const handler = createHandler({
    async writeTrace(_tableName, item) {
      traceItems.push(item);
    },
    async sendResponseEmail(message) {
      sentMessages.push(message);
    }
  });

  const previousTraceTable = process.env.TRACE_TABLE_NAME;
  const previousResponseMode = process.env.RESPONSE_MODE;
  const previousSenderEmail = process.env.SENDER_EMAIL;
  const previousCalendarMode = process.env.CALENDAR_MODE;

  process.env.TRACE_TABLE_NAME = "TraceTable";
  process.env.RESPONSE_MODE = "send";
  process.env.SENDER_EMAIL = "agent@agent.letsconnect.ai";
  process.env.CALENDAR_MODE = "mock";

  try {
    const response = await handler({
      Records: [
        {
          ses: {
            mail: {
              commonHeaders: {
                from: ["Titoneeda <titoneeda@gmail.com>"],
                subject: "Need 30 min chat"
              }
            }
          }
        }
      ]
    });

    assert.equal(response.statusCode, 200);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].recipientEmail, "titoneeda@gmail.com");
    assert.equal(traceItems[0].fromDomain, "gmail.com");
  } finally {
    if (previousTraceTable === undefined) {
      delete process.env.TRACE_TABLE_NAME;
    } else {
      process.env.TRACE_TABLE_NAME = previousTraceTable;
    }

    if (previousResponseMode === undefined) {
      delete process.env.RESPONSE_MODE;
    } else {
      process.env.RESPONSE_MODE = previousResponseMode;
    }

    if (previousSenderEmail === undefined) {
      delete process.env.SENDER_EMAIL;
    } else {
      process.env.SENDER_EMAIL = previousSenderEmail;
    }

    if (previousCalendarMode === undefined) {
      delete process.env.CALENDAR_MODE;
    } else {
      process.env.CALENDAR_MODE = previousCalendarMode;
    }
  }
});
