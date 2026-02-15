import test from "node:test";
import assert from "node:assert/strict";
import { processSchedulingEmail } from "../src/handler.js";

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
