import crypto from "node:crypto";
import { parseSchedulingRequest } from "./intent-parser.js";
import { generateCandidateSlots } from "./slot-generator.js";
import { parseGoogleOauthSecret, lookupGoogleBusyIntervals } from "./google-adapter.js";
import { buildClientResponse } from "./response-builder.js";
import { createRuntimeDeps } from "./runtime-deps.js";

function parseIntEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function normalizeRequestedWindowsToUtc(requestedWindows) {
  return requestedWindows
    .map((window) => {
      const startMs = Date.parse(window.startIso);
      const endMs = Date.parse(window.endIso);
      if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
        return null;
      }

      return {
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(endMs).toISOString()
      };
    })
    .filter(Boolean);
}

function parseIncomingPayload(event) {
  if (event?.version === "2.0") {
    if (!event.body) {
      return {};
    }

    return typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  }

  if (event?.Records?.[0]?.ses) {
    const record = event.Records[0];
    return {
      fromEmail: record.ses.mail.commonHeaders.from?.[0],
      subject: record.ses.mail.commonHeaders.subject ?? "",
      body: "",
      channel: "email"
    };
  }

  return event ?? {};
}

function ok(body) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

function badRequest(message) {
  return {
    statusCode: 400,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: message })
  };
}

function serverError(requestId, message) {
  return {
    statusCode: 500,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, error: message })
  };
}

export async function processSchedulingEmail({ payload, env, deps, now = () => Date.now() }) {
  const requestId = crypto.randomUUID();
  const responseId = crypto.randomUUID();
  const startedAtMs = now();
  const startedAtIso = new Date(startedAtMs).toISOString();

  const fromEmail = payload.fromEmail?.trim().toLowerCase();
  if (!fromEmail) {
    return { http: badRequest("fromEmail is required") };
  }

  const hostTimezone = env.HOST_TIMEZONE ?? "America/Los_Angeles";
  const advisingDays = (env.ADVISING_DAYS ?? "Tue,Wed")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const durationDefault = parseIntEnv(env.DEFAULT_DURATION_MINUTES, 30);
  const durationLimit = parseIntEnv(env.MAX_DURATION_MINUTES, 120);
  const searchDays = parseIntEnv(env.SEARCH_DAYS, 14);
  const maxSuggestions = parseIntEnv(env.MAX_SUGGESTIONS, 3);
  const workdayStartHour = parseIntEnv(env.WORKDAY_START_HOUR, 9);
  const workdayEndHour = parseIntEnv(env.WORKDAY_END_HOUR, 17);
  const responseMode = (env.RESPONSE_MODE ?? "log").toLowerCase();
  const calendarMode = (env.CALENDAR_MODE ?? "mock").toLowerCase();
  const advisorId = env.ADVISOR_ID ?? "manoj";

  const parsed = parseSchedulingRequest({
    fromEmail,
    subject: payload.subject ?? "",
    body: payload.body ?? "",
    defaultDurationMinutes: durationDefault
  });

  if (parsed.durationMinutes > durationLimit) {
    return { http: badRequest(`duration exceeds limit (${durationLimit} minutes)`) };
  }

  const searchStartIso = new Date(startedAtMs).toISOString();
  const searchEndIso = new Date(startedAtMs + searchDays * 24 * 60 * 60 * 1000).toISOString();

  let busyIntervals = [];
  let providerStatus = "ok";

  try {
    if (calendarMode === "mock") {
      busyIntervals = payload.mockBusyIntervals ?? [];
    } else if (calendarMode === "google") {
      const secretArn = env.GOOGLE_OAUTH_SECRET_ARN;
      if (!secretArn) {
        throw new Error("GOOGLE_OAUTH_SECRET_ARN is required for CALENDAR_MODE=google");
      }

      const secretString = await deps.getSecretString(secretArn);
      const oauthConfig = parseGoogleOauthSecret(secretString);
      busyIntervals = await deps.lookupBusyIntervals({
        oauthConfig,
        windowStartIso: searchStartIso,
        windowEndIso: searchEndIso,
        fetchImpl: deps.fetchImpl
      });
    } else if (calendarMode === "connection") {
      const connectionsTableName = env.CONNECTIONS_TABLE_NAME;
      if (!connectionsTableName) {
        throw new Error("CONNECTIONS_TABLE_NAME is required for CALENDAR_MODE=connection");
      }

      const connection = await deps.getPrimaryConnection(connectionsTableName, advisorId);
      if (!connection) {
        throw new Error("No connected calendars found. Add a calendar in Advisor Portal.");
      }

      if (connection.provider === "mock") {
        busyIntervals = [];
      } else if (connection.provider === "google") {
        if (!connection.secretArn) {
          throw new Error("Google connection is missing secretArn");
        }

        const secretString = await deps.getSecretString(connection.secretArn);
        const oauthConfig = parseGoogleOauthSecret(secretString);
        busyIntervals = await deps.lookupBusyIntervals({
          oauthConfig,
          windowStartIso: searchStartIso,
          windowEndIso: searchEndIso,
          fetchImpl: deps.fetchImpl
        });
      } else {
        throw new Error(`Unsupported provider for CALENDAR_MODE=connection: ${connection.provider}`);
      }
    } else {
      throw new Error(`Unsupported CALENDAR_MODE value: ${calendarMode}`);
    }
  } catch (error) {
    providerStatus = "error";
    await deps.writeTrace(env.TRACE_TABLE_NAME, {
      requestId,
      responseId,
      status: "failed",
      stage: "calendar_lookup",
      providerStatus,
      errorCode: "CALENDAR_LOOKUP_FAILED",
      createdAt: startedAtIso,
      updatedAt: new Date(now()).toISOString(),
      fromDomain: fromEmail.split("@")[1] ?? "unknown",
      expiresAt: Math.floor((startedAtMs + 7 * 24 * 60 * 60 * 1000) / 1000)
    });

    return {
      http: serverError(requestId, `calendar lookup failed: ${error.message}`)
    };
  }

  const suggestions = generateCandidateSlots({
    busyIntervalsUtc: busyIntervals,
    requestedWindowsUtc: normalizeRequestedWindowsToUtc(parsed.requestedWindows),
    hostTimezone,
    advisingWeekdays: advisingDays,
    searchStartUtc: searchStartIso,
    searchEndUtc: searchEndIso,
    workdayStartHour,
    workdayEndHour,
    durationMinutes: parsed.durationMinutes,
    maxSuggestions
  });

  const responseMessage = buildClientResponse({
    suggestions,
    hostTimezone,
    clientTimezone: parsed.clientTimezone,
    subject: payload.subject
  });

  let deliveryStatus = "logged";

  if (responseMode === "send") {
    if (!env.SENDER_EMAIL) {
      return { http: badRequest("SENDER_EMAIL is required when RESPONSE_MODE=send") };
    }

    await deps.sendResponseEmail({
      senderEmail: env.SENDER_EMAIL,
      recipientEmail: fromEmail,
      subject: responseMessage.subject,
      bodyText: responseMessage.bodyText
    });

    deliveryStatus = "sent";
  }

  const completedAtMs = now();
  await deps.writeTrace(env.TRACE_TABLE_NAME, {
    requestId,
    responseId,
    status: "completed",
    providerStatus,
    channel: payload.channel ?? "email",
    fromDomain: fromEmail.split("@")[1] ?? "unknown",
    meetingType: parsed.meetingType,
    suggestionCount: suggestions.length,
    durationMinutes: parsed.durationMinutes,
    responseMode,
    calendarMode,
    createdAt: startedAtIso,
    updatedAt: new Date(completedAtMs).toISOString(),
    latencyMs: completedAtMs - startedAtMs,
    expiresAt: Math.floor((startedAtMs + 7 * 24 * 60 * 60 * 1000) / 1000)
  });

  return {
    http: ok({
      requestId,
      responseId,
      deliveryStatus,
      suggestionCount: suggestions.length,
      suggestions
    })
  };
}

export function createHandler(overrides = {}) {
  const runtimeDeps = createRuntimeDeps();
  const deps = {
    ...runtimeDeps,
    lookupBusyIntervals: lookupGoogleBusyIntervals,
    ...overrides
  };

  return async function handler(event) {
    const payload = parseIncomingPayload(event);
    const result = await processSchedulingEmail({
      payload,
      env: process.env,
      deps
    });

    return result.http;
  };
}

export const handler = createHandler();
