import crypto from "node:crypto";
import { parseSchedulingRequest } from "./intent-parser.js";
import { generateCandidateSlots } from "./slot-generator.js";
import { parseGoogleOauthSecret, lookupGoogleBusyIntervals } from "./google-adapter.js";
import { draftResponseWithOpenAi, extractSchedulingIntentWithOpenAi, parseOpenAiConfigSecret } from "./llm-adapter.js";
import { buildClientResponse } from "./response-builder.js";
import { buildClientReference, createShortAvailabilityTokenId } from "./availability-link.js";
import {
  isClientAccessRestricted,
  normalizeClientAccessState,
  normalizeClientId,
  parseAdvisingDaysList,
  parseClientPolicyPresets,
  resolveClientAdvisingDays
} from "./client-profile.js";
import { createRuntimeDeps } from "./runtime-deps.js";
import { simpleParser } from "mailparser";

const DEFAULT_INTENT_CONFIDENCE_THRESHOLD = 0.65;
const DEFAULT_AVAILABILITY_LINK_TTL_MINUTES = 7 * 24 * 60;

function parseIntEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseClampedIntEnv(value, fallback, minimum, maximum) {
  const parsed = parseIntEnv(value, fallback);
  return Math.min(Math.max(parsed, minimum), maximum);
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

function mergeParsedIntent({
  parserIntent,
  llmIntent,
  confidenceThreshold = DEFAULT_INTENT_CONFIDENCE_THRESHOLD
}) {
  if (!llmIntent) {
    return {
      parsed: parserIntent,
      intentSource: "parser"
    };
  }

  const llmWindows = Array.isArray(llmIntent.requestedWindows) ? llmIntent.requestedWindows : [];
  const parserWindows = Array.isArray(parserIntent.requestedWindows) ? parserIntent.requestedWindows : [];
  const shouldUseLlmWindows =
    llmWindows.length > 0 && (parserWindows.length === 0 || Number(llmIntent.confidence ?? 0) >= confidenceThreshold);

  if (!shouldUseLlmWindows) {
    return {
      parsed: {
        ...parserIntent,
        clientTimezone: parserIntent.clientTimezone ?? llmIntent.clientTimezone ?? null
      },
      intentSource: "parser"
    };
  }

  return {
    parsed: {
      ...parserIntent,
      requestedWindows: llmWindows,
      clientTimezone: parserIntent.clientTimezone ?? llmIntent.clientTimezone ?? null
    },
    intentSource: parserWindows.length > 0 ? "llm_override" : "llm"
  };
}

function appendAvailabilityLinkSection({ responseMessage, availabilityLink }) {
  if (!availabilityLink) {
    return responseMessage;
  }

  const bodyText = String(responseMessage.bodyText ?? "").trim();
  const bodyWithLink = [
    bodyText,
    "",
    "Want to browse all currently open times?",
    `Availability link: ${availabilityLink}`,
    "This secure link expires automatically."
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ...responseMessage,
    bodyText: bodyWithLink
  };
}

function titleCaseWords(input) {
  return String(input ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (!word) {
        return "";
      }

      return word[0].toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function deriveClientDisplayName(rawFromEmail, normalizedFromEmail) {
  const rawValue = String(rawFromEmail ?? "").trim();
  const bracketIndex = rawValue.indexOf("<");
  if (bracketIndex > 0) {
    const namePart = rawValue
      .slice(0, bracketIndex)
      .trim()
      .replace(/^["']+|["']+$/g, "");
    if (namePart && !namePart.includes("@")) {
      return namePart.slice(0, 64);
    }
  }

  const localPart = String(normalizedFromEmail ?? "")
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!localPart) {
    return "Client";
  }

  return titleCaseWords(localPart).slice(0, 64);
}

function deriveAdvisorDisplayName(rawAdvisorDisplayName, advisorId) {
  const explicitName = String(rawAdvisorDisplayName ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (explicitName) {
    return explicitName.slice(0, 64);
  }

  const advisorIdValue = String(advisorId ?? "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!advisorIdValue) {
    return "Advisor";
  }

  return titleCaseWords(advisorIdValue).slice(0, 64);
}

function ensurePersonalizedGreetingAndSignature({
  responseMessage,
  clientDisplayName,
  advisorDisplayName
}) {
  const greetingName = String(clientDisplayName ?? "").trim() || "there";
  const signoffName = String(advisorDisplayName ?? "").trim() || "Advisor";
  const greetingLine = `Hi ${greetingName},`;

  const rawBody = String(responseMessage.bodyText ?? "").replace(/\r\n/g, "\n");
  const lines = rawBody.split("\n");

  while (lines.length > 0 && lines[0].trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  if (lines.length === 0) {
    lines.push(greetingLine, "", "Best regards,", signoffName);
    return {
      ...responseMessage,
      bodyText: lines.join("\n")
    };
  }

  if (/^(hi|hello)\b/i.test(lines[0].trim())) {
    lines[0] = greetingLine;
  } else {
    lines.unshift(greetingLine, "");
  }

  let signoffIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index].trim();
    if (/^(best regards|best|regards)[,!]?$/i.test(candidate)) {
      signoffIndex = index;
      break;
    }
  }

  if (signoffIndex >= 0) {
    lines[signoffIndex] = "Best regards,";
    let nameLineIndex = signoffIndex + 1;
    while (nameLineIndex < lines.length && lines[nameLineIndex].trim() === "") {
      nameLineIndex += 1;
    }

    if (nameLineIndex < lines.length) {
      lines[nameLineIndex] = signoffName;
    } else {
      lines.push(signoffName);
    }
  } else {
    lines.push("", "Best regards,", signoffName);
  }

  return {
    ...responseMessage,
    bodyText: lines.join("\n")
  };
}

async function buildAvailabilityLink({
  env,
  deps,
  advisorId,
  clientTimezone,
  durationMinutes,
  issuedAtMs,
  normalizedClientEmail,
  clientDisplayName,
  clientId
}) {
  const baseUrl = String(env.AVAILABILITY_LINK_BASE_URL ?? "").trim();
  const tableName = String(env.AVAILABILITY_LINK_TABLE_NAME ?? "").trim();
  if (!baseUrl || !tableName) {
    return {
      availabilityLink: null,
      status: "unconfigured"
    };
  }

  const ttlMinutes = parseClampedIntEnv(
    env.AVAILABILITY_LINK_TTL_MINUTES,
    DEFAULT_AVAILABILITY_LINK_TTL_MINUTES,
    15,
    14 * 24 * 60
  );
  const expiresAtMs = issuedAtMs + ttlMinutes * 60 * 1000;
  const clientReference = buildClientReference(clientDisplayName, normalizedClientEmail);
  const issuedAtIso = new Date(issuedAtMs).toISOString();
  const expiresAt = Math.floor(expiresAtMs / 1000);

  let tokenId = null;
  for (let attempt = 0; attempt < 3 && !tokenId; attempt += 1) {
    const candidateId = createShortAvailabilityTokenId();
    try {
      await deps.putAvailabilityLink(tableName, {
        tokenId: candidateId,
        advisorId,
        clientId,
        clientEmail: normalizedClientEmail,
        clientDisplayName,
        clientReference,
        clientTimezone: clientTimezone ?? null,
        durationMinutes,
        issuedAt: issuedAtIso,
        expiresAtMs,
        expiresAt
      });
      tokenId = candidateId;
    } catch (error) {
      if (error?.name !== "ConditionalCheckFailedException") {
        throw error;
      }
    }
  }

  if (!tokenId) {
    throw new Error("Failed to allocate unique availability token ID");
  }

  const availabilityUrl = new URL(baseUrl);
  availabilityUrl.searchParams.set("t", tokenId);
  availabilityUrl.searchParams.set("for", clientReference);
  return {
    availabilityLink: availabilityUrl.toString(),
    status: "included"
  };
}

function normalizeEmailAddress(rawValue) {
  const candidate = String(rawValue ?? "")
    .trim()
    .toLowerCase();
  if (!candidate) {
    return "";
  }

  // Handles common header formats like: "Name <user@example.com>".
  const emailMatch = candidate.match(/[a-z0-9._%+-]+@[a-z0-9.-]+/);
  if (emailMatch) {
    return emailMatch[0];
  }

  return candidate.replace(/[<>]/g, "").trim();
}

function buildAccessDeniedResponseMessage() {
  return {
    subject: "Re: Scheduling request",
    bodyText:
      "This scheduling interface is currently unavailable for your account.\nPlease contact the advisor directly if you need help booking time."
  };
}

function extractDomainFromEmail(normalizedEmail) {
  const atIndex = normalizedEmail.lastIndexOf("@");
  if (atIndex < 0 || atIndex === normalizedEmail.length - 1) {
    return "unknown";
  }

  return normalizedEmail.slice(atIndex + 1);
}

async function parsePlainTextFromMime(rawMime) {
  if (!rawMime) {
    return "";
  }

  try {
    const parsed = await simpleParser(rawMime);
    const plainText = String(parsed.text ?? "").trim();
    if (plainText) {
      return plainText;
    }

    // Some senders provide HTML-only multipart messages. Fall back to a
    // lightweight HTML-to-text conversion so scheduling intent still parses.
    const html = typeof parsed.html === "string" ? parsed.html : "";
    if (!html) {
      return "";
    }

    return html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function buildRawEmailLocation(payload, env) {
  const sesReceiptMailStore = payload?.ses?.receipt?.mailStore;
  if (sesReceiptMailStore?.bucket && sesReceiptMailStore?.key) {
    return {
      bucket: String(sesReceiptMailStore.bucket),
      key: String(sesReceiptMailStore.key),
      region: String(sesReceiptMailStore.region || env.RAW_EMAIL_BUCKET_REGION || "")
    };
  }

  const messageId = String(payload?.ses?.messageId ?? "").trim();
  const bucket = String(env.RAW_EMAIL_BUCKET ?? "").trim();
  if (!messageId || !bucket) {
    return null;
  }

  const prefix = String(env.RAW_EMAIL_OBJECT_PREFIX ?? "").trim();
  return {
    bucket,
    key: `${prefix}${messageId}`,
    region: String(env.RAW_EMAIL_BUCKET_REGION ?? "").trim()
  };
}

async function resolveInboundEmailBody({ payload, env, deps }) {
  const inlineBody = String(payload.body ?? "").trim();
  if (inlineBody) {
    return {
      bodyText: inlineBody,
      bodySource: "inline"
    };
  }

  const rawEmailLocation = buildRawEmailLocation(payload, env);
  if (!rawEmailLocation) {
    return {
      bodyText: "",
      bodySource: "none"
    };
  }

  try {
    const rawMime = await deps.getRawEmailObject(rawEmailLocation);
    const bodyText = await parsePlainTextFromMime(rawMime);
    return {
      bodyText,
      bodySource: "mail_store"
    };
  } catch {
    return {
      bodyText: "",
      bodySource: "mail_store_unavailable"
    };
  } finally {
    try {
      await deps.deleteRawEmailObject(rawEmailLocation);
    } catch {
      // Best-effort delete to keep raw email retention minimal.
    }
  }
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
    const sesMail = record.ses.mail ?? {};
    const commonHeaders = sesMail.commonHeaders ?? {};

    return {
      fromEmail: commonHeaders.from?.[0] ?? sesMail.source ?? "",
      subject: commonHeaders.subject ?? "",
      body: "",
      channel: "email",
      ses: {
        messageId: sesMail.messageId ?? "",
        source: sesMail.source ?? "",
        destination: sesMail.destination ?? [],
        receipt: record.ses.receipt ?? {}
      }
    };
  }

  return event ?? {};
}

function normalizeRawPath(rawPath, stage) {
  const path = rawPath || "/";
  if (!stage || stage === "$default") {
    return path;
  }

  if (path === `/${stage}`) {
    return "/";
  }

  const stagePrefix = `/${stage}/`;
  if (path.startsWith(stagePrefix)) {
    return path.slice(stagePrefix.length - 1);
  }

  return path;
}

function ok(body) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

function notFound() {
  return {
    statusCode: 404,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: "Not found" })
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

const FEEDBACK_TYPE_VALUES = new Set(["incorrect", "odd", "helpful", "other"]);
const FEEDBACK_REASON_VALUES = new Set([
  "availability_mismatch",
  "timezone_issue",
  "tone_quality",
  "latency",
  "other"
]);
const FEEDBACK_SOURCE_VALUES = new Set(["client", "advisor", "system"]);

function validateFeedbackField(rawValue, allowedValues, fieldName, defaultValue) {
  const normalized = String(rawValue ?? defaultValue)
    .trim()
    .toLowerCase();
  if (!allowedValues.has(normalized)) {
    throw new Error(`${fieldName} must be one of: ${Array.from(allowedValues).join(", ")}`);
  }

  return normalized;
}

function parseFeedbackPayload(payload) {
  const requestId = String(payload.requestId ?? "").trim();
  const responseId = String(payload.responseId ?? "").trim();
  if (!requestId || !responseId) {
    throw new Error("requestId and responseId are required");
  }

  const feedbackType = validateFeedbackField(payload.feedbackType, FEEDBACK_TYPE_VALUES, "feedbackType", "other");
  const feedbackReason = validateFeedbackField(
    payload.feedbackReason,
    FEEDBACK_REASON_VALUES,
    "feedbackReason",
    "other"
  );
  const feedbackSource = validateFeedbackField(
    payload.feedbackSource,
    FEEDBACK_SOURCE_VALUES,
    "feedbackSource",
    "client"
  );

  return {
    requestId,
    responseId,
    feedbackType,
    feedbackReason,
    feedbackSource
  };
}

export async function processSchedulingFeedback({ payload, env, deps, now = () => Date.now() }) {
  if (!env.TRACE_TABLE_NAME) {
    return { http: serverError(null, "TRACE_TABLE_NAME is required") };
  }

  let feedback;
  try {
    feedback = parseFeedbackPayload(payload);
  } catch (error) {
    return { http: badRequest(error.message) };
  }

  const updatedAt = new Date(now()).toISOString();
  const updated = await deps.updateTraceFeedback(env.TRACE_TABLE_NAME, {
    requestId: feedback.requestId,
    responseId: feedback.responseId,
    feedbackSource: feedback.feedbackSource,
    feedbackType: feedback.feedbackType,
    feedbackReason: feedback.feedbackReason,
    updatedAt
  });

  if (!updated) {
    return {
      http: {
        statusCode: 404,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "requestId and responseId were not found" })
      }
    };
  }

  return {
    http: ok({
      requestId: feedback.requestId,
      responseId: feedback.responseId,
      feedbackRecorded: true,
      feedbackSource: feedback.feedbackSource,
      feedbackType: feedback.feedbackType,
      feedbackReason: feedback.feedbackReason,
      feedbackUpdatedAt: updatedAt
    })
  };
}

export async function processSchedulingEmail({ payload, env, deps, now = () => Date.now() }) {
  const requestId = crypto.randomUUID();
  const responseId = crypto.randomUUID();
  const startedAtMs = now();
  const startedAtIso = new Date(startedAtMs).toISOString();

  const fromEmail = normalizeEmailAddress(payload.fromEmail);
  if (!fromEmail) {
    return { http: badRequest("fromEmail is required") };
  }
  const clientId = normalizeClientId(fromEmail);
  const clientDisplayName = deriveClientDisplayName(payload.fromEmail, fromEmail);
  const fromDomain = extractDomainFromEmail(fromEmail);
  const { bodyText, bodySource } = await resolveInboundEmailBody({ payload, env, deps });

  const hostTimezone = env.HOST_TIMEZONE ?? "America/Los_Angeles";
  const defaultAdvisingDays = parseAdvisingDaysList(env.ADVISING_DAYS ?? "Tue,Wed", ["Tue", "Wed"]);

  const durationDefault = parseIntEnv(env.DEFAULT_DURATION_MINUTES, 30);
  const durationLimit = parseIntEnv(env.MAX_DURATION_MINUTES, 120);
  const searchDays = parseIntEnv(env.SEARCH_DAYS, 14);
  const maxSuggestions = parseIntEnv(env.MAX_SUGGESTIONS, 3);
  const workdayStartHour = parseIntEnv(env.WORKDAY_START_HOUR, 9);
  const workdayEndHour = parseIntEnv(env.WORKDAY_END_HOUR, 17);
  const responseMode = (env.RESPONSE_MODE ?? "log").toLowerCase();
  const calendarMode = (env.CALENDAR_MODE ?? "mock").toLowerCase();
  const advisorId = env.ADVISOR_ID ?? "manoj";
  const advisorDisplayName = deriveAdvisorDisplayName(env.ADVISOR_DISPLAY_NAME, advisorId);
  const llmMode = (env.LLM_MODE ?? "disabled").toLowerCase();
  const llmTimeoutMs = parseIntEnv(env.LLM_TIMEOUT_MS, 4000);
  const llmProviderSecretArn = env.LLM_PROVIDER_SECRET_ARN ?? "";
  const intentExtractionMode = (env.INTENT_EXTRACTION_MODE ?? "llm_hybrid").toLowerCase();
  const intentLlmTimeoutMs = parseIntEnv(env.INTENT_LLM_TIMEOUT_MS, 10000);
  const intentConfidenceThreshold = Number.parseFloat(
    env.INTENT_LLM_CONFIDENCE_THRESHOLD ?? String(DEFAULT_INTENT_CONFIDENCE_THRESHOLD)
  );
  const clientProfilesTableName = String(env.CLIENT_PROFILES_TABLE_NAME ?? "").trim();
  const policyPresets = parseClientPolicyPresets(env.CLIENT_POLICY_PRESETS_JSON, defaultAdvisingDays);

  let clientProfile = null;
  if (clientProfilesTableName && typeof deps.getClientProfile === "function") {
    try {
      clientProfile = await deps.getClientProfile(clientProfilesTableName, advisorId, clientId);
    } catch {
      clientProfile = null;
    }
  }

  const accessState = normalizeClientAccessState(clientProfile?.accessState, "active");
  if (isClientAccessRestricted(clientProfile)) {
    const deniedMessage = ensurePersonalizedGreetingAndSignature({
      responseMessage: buildAccessDeniedResponseMessage(),
      clientDisplayName,
      advisorDisplayName
    });
    let deliveryStatus = "logged";
    if (responseMode === "send" && env.SENDER_EMAIL) {
      await deps.sendResponseEmail({
        senderEmail: env.SENDER_EMAIL,
        recipientEmail: fromEmail,
        subject: deniedMessage.subject,
        bodyText: deniedMessage.bodyText
      });
      deliveryStatus = "sent";
    }

    await deps.writeTrace(env.TRACE_TABLE_NAME, {
      requestId,
      responseId,
      advisorId,
      status: "denied",
      stage: "access_control",
      providerStatus: "skipped",
      channel: payload.channel ?? "email",
      fromDomain,
      responseMode,
      calendarMode: (env.CALENDAR_MODE ?? "mock").toLowerCase(),
      llmMode: (env.LLM_MODE ?? "disabled").toLowerCase(),
      llmStatus: "disabled",
      bodySource,
      intentSource: "parser",
      intentLlmStatus: "disabled",
      availabilityLinkStatus: "not_applicable",
      requestedWindowCount: 0,
      accessState,
      createdAt: startedAtIso,
      updatedAt: new Date(now()).toISOString(),
      latencyMs: now() - startedAtMs,
      expiresAt: Math.floor((startedAtMs + 7 * 24 * 60 * 60 * 1000) / 1000)
    });

    return {
      http: ok({
        requestId,
        responseId,
        deliveryStatus,
        llmStatus: "disabled",
        suggestionCount: 0,
        suggestions: [],
        accessDenied: true,
        accessState
      })
    };
  }

  const advisingDays = resolveClientAdvisingDays({
    clientProfile,
    defaultAdvisingDays,
    policyPresets
  });

  const parserIntent = parseSchedulingRequest({
    fromEmail,
    subject: payload.subject ?? "",
    body: bodyText,
    defaultDurationMinutes: durationDefault,
    fallbackTimezone: hostTimezone,
    referenceIso: startedAtIso
  });

  let parsed = parserIntent;
  let intentSource = "parser";
  let intentLlmStatus = "disabled";

  if (intentExtractionMode === "llm_hybrid") {
    try {
      if (!llmProviderSecretArn) {
        throw new Error("LLM_PROVIDER_SECRET_ARN is required for INTENT_EXTRACTION_MODE=llm_hybrid");
      }

      const llmSecretString = await deps.getSecretString(llmProviderSecretArn);
      const openAiConfig = parseOpenAiConfigSecret(llmSecretString);
      const llmIntent = await deps.extractSchedulingIntentWithLlm({
        openAiConfig,
        subject: payload.subject ?? "",
        body: bodyText,
        hostTimezone,
        referenceNowIso: startedAtIso,
        fetchImpl: deps.fetchImpl,
        timeoutMs: intentLlmTimeoutMs
      });

      const merged = mergeParsedIntent({
        parserIntent,
        llmIntent,
        confidenceThreshold: Number.isFinite(intentConfidenceThreshold)
          ? intentConfidenceThreshold
          : DEFAULT_INTENT_CONFIDENCE_THRESHOLD
      });
      parsed = merged.parsed;
      intentSource = merged.intentSource;
      intentLlmStatus = "ok";
    } catch {
      parsed = parserIntent;
      intentSource = "parser";
      intentLlmStatus = "fallback";
    }
  }

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
      advisorId,
      status: "failed",
      stage: "calendar_lookup",
      providerStatus,
      errorCode: "CALENDAR_LOOKUP_FAILED",
      bodySource,
      intentSource,
      intentLlmStatus,
      requestedWindowCount: parsed.requestedWindows.length,
      createdAt: startedAtIso,
      updatedAt: new Date(now()).toISOString(),
      fromDomain,
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

  const templateResponseMessage = buildClientResponse({
    suggestions,
    hostTimezone,
    clientTimezone: parsed.clientTimezone,
    subject: payload.subject
  });
  let responseMessage = templateResponseMessage;
  let llmStatus = "disabled";
  let availabilityLinkStatus = suggestions.length > 0 ? "pending" : "not_applicable";

  if (llmMode === "openai") {
    try {
      if (!llmProviderSecretArn) {
        throw new Error("LLM_PROVIDER_SECRET_ARN is required for LLM_MODE=openai");
      }

      const llmSecretString = await deps.getSecretString(llmProviderSecretArn);
      const openAiConfig = parseOpenAiConfigSecret(llmSecretString);
      responseMessage = await deps.draftResponseWithLlm({
        openAiConfig,
        suggestions,
        hostTimezone,
        clientTimezone: parsed.clientTimezone,
        originalSubject: payload.subject,
        fetchImpl: deps.fetchImpl,
        timeoutMs: llmTimeoutMs
      });
      llmStatus = "ok";
    } catch {
      llmStatus = "fallback";
      responseMessage = templateResponseMessage;
    }
  } else if (llmMode !== "disabled") {
    llmStatus = "unsupported";
  }

  if (suggestions.length > 0) {
    try {
      const availabilityLinkResult = await buildAvailabilityLink({
        env,
        deps,
        advisorId,
        clientTimezone: parsed.clientTimezone,
        durationMinutes: parsed.durationMinutes,
        issuedAtMs: startedAtMs,
        normalizedClientEmail: fromEmail,
        clientDisplayName,
        clientId
      });
      availabilityLinkStatus = availabilityLinkResult.status;
      responseMessage = appendAvailabilityLinkSection({
        responseMessage,
        availabilityLink: availabilityLinkResult.availabilityLink
      });
    } catch {
      availabilityLinkStatus = "error";
    }
  }

  responseMessage = ensurePersonalizedGreetingAndSignature({
    responseMessage,
    clientDisplayName,
    advisorDisplayName
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
    advisorId,
    accessState,
    status: "completed",
    providerStatus,
    channel: payload.channel ?? "email",
    fromDomain,
    meetingType: parsed.meetingType,
    suggestionCount: suggestions.length,
    durationMinutes: parsed.durationMinutes,
    responseMode,
    calendarMode,
    llmMode,
    llmStatus,
    bodySource,
    intentSource,
    intentLlmStatus,
    availabilityLinkStatus,
    requestedWindowCount: parsed.requestedWindows.length,
    createdAt: startedAtIso,
    updatedAt: new Date(completedAtMs).toISOString(),
    latencyMs: completedAtMs - startedAtMs,
    expiresAt: Math.floor((startedAtMs + 7 * 24 * 60 * 60 * 1000) / 1000)
  });

  if (clientProfilesTableName && typeof deps.recordClientEmailInteraction === "function") {
    try {
      await deps.recordClientEmailInteraction(clientProfilesTableName, {
        advisorId,
        clientId,
        clientEmail: fromEmail,
        clientDisplayName,
        accessState,
        policyId: clientProfile?.policyId ?? "default",
        updatedAt: new Date(completedAtMs).toISOString()
      });
    } catch {
      // Best-effort client analytics tracking.
    }
  }

  return {
    http: ok({
      requestId,
      responseId,
      deliveryStatus,
      llmStatus,
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
    draftResponseWithLlm: draftResponseWithOpenAi,
    extractSchedulingIntentWithLlm: extractSchedulingIntentWithOpenAi,
    ...overrides
  };

  return async function handler(event) {
    const method = event?.requestContext?.http?.method ?? "POST";
    const rawPath = normalizeRawPath(event?.rawPath ?? "/spike/email", event?.requestContext?.stage);

    if (event?.version === "2.0" && method === "POST" && rawPath === "/spike/feedback") {
      const payload = parseIncomingPayload(event);
      const result = await processSchedulingFeedback({
        payload,
        env: process.env,
        deps
      });

      return result.http;
    }

    if (event?.version === "2.0" && rawPath !== "/spike/email") {
      return notFound();
    }

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
