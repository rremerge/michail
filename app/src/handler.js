import crypto from "node:crypto";
import { DateTime } from "luxon";
import { parseSchedulingRequest } from "./intent-parser.js";
import { generateCandidateSlots } from "./slot-generator.js";
import {
  createGoogleMeetSpace,
  exchangeRefreshToken,
  parseGoogleOauthSecret,
  lookupGoogleBusyIntervals
} from "./google-adapter.js";
import { parseMicrosoftOauthSecret, lookupMicrosoftBusyIntervals } from "./microsoft-adapter.js";
import {
  createZoomMeeting,
  exchangeZoomRefreshToken,
  parseZoomAppSecret,
  parseZoomMeetingSecret
} from "./zoom-adapter.js";
import {
  analyzePromptInjectionRiskWithOpenAi,
  assessPromptInjectionRisk,
  draftResponseWithOpenAi,
  extractSchedulingIntentWithOpenAi,
  parseOpenAiConfigSecret,
  suggestInviteSubjectWithOpenAi
} from "./llm-adapter.js";
import { buildClientResponse } from "./response-builder.js";
import { buildClientReference, createShortAvailabilityTokenId } from "./availability-link.js";
import {
  isClientAccessRestricted,
  mergeClientPolicyPresets,
  normalizeClientAccessState,
  normalizeClientId,
  normalizePolicyId,
  parseAdvisingDaysList,
  parseClientPolicyPresets,
  resolveClientAdvisingDays
} from "./client-profile.js";
import { createRuntimeDeps } from "./runtime-deps.js";
import { simpleParser } from "mailparser";

const DEFAULT_INTENT_CONFIDENCE_THRESHOLD = 0.65;
const DEFAULT_BOOKING_INTENT_CONFIDENCE_THRESHOLD = 0.75;
const DEFAULT_AGENT_INVOCATION_LLM_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_AVAILABILITY_LINK_TTL_MINUTES = 7 * 24 * 60;
const DEFAULT_ADVISOR_TIMEZONE = "America/Los_Angeles";
const DEFAULT_PROMPT_GUARD_MODE = "heuristic_llm";
const DEFAULT_PROMPT_GUARD_BLOCK_LEVEL = "high";
const DEFAULT_PROMPT_GUARD_LLM_TIMEOUT_MS = 3000;
const DEFAULT_CALENDAR_INVITE_TITLE = "Advisory Meeting";
const DEFAULT_MEETING_LINK_PROVIDER = "google_meet";
const SUPPORTED_MEETING_LINK_PROVIDERS = new Set(["google_meet", "zoom", "static_url"]);
const MEETING_LINK_ERROR_MESSAGE_MAX_LENGTH = 240;
const DAYPART_PATTERN = /\b(early morning|late morning|late afternoon|morning|afternoon|evening|night|noon|lunch)\b/gi;
const DAYPART_WINDOWS = {
  "early morning": { startMinute: 8 * 60, endMinute: 10 * 60 },
  "late morning": { startMinute: 10 * 60, endMinute: 12 * 60 },
  morning: { startMinute: 9 * 60, endMinute: 12 * 60 },
  noon: { startMinute: 12 * 60, endMinute: 13 * 60 },
  lunch: { startMinute: 12 * 60, endMinute: 13 * 60 },
  afternoon: { startMinute: 13 * 60, endMinute: 17 * 60 },
  "late afternoon": { startMinute: 15 * 60, endMinute: 18 * 60 },
  evening: { startMinute: 17 * 60, endMinute: 20 * 60 },
  night: { startMinute: 19 * 60, endMinute: 22 * 60 }
};
const PROMPT_GUARD_LEVEL_RANK = {
  low: 0,
  medium: 1,
  high: 2
};
const EXPLICIT_BOOKING_INTENT_KEYWORDS =
  /\b(book|confirm|lock|reserve|schedule|send (?:me )?(?:the )?invite|calendar invite|works for me|that works|go ahead)\b/i;
const AFFIRMATIVE_BOOKING_INTENT_KEYWORDS =
  /\b(works|great|perfect|excellent|sounds good|looks good|yes|yep|yeah|ok|okay|lets do it|let's do it)\b/i;
const NEGATIVE_BOOKING_INTENT_KEYWORDS = /\b(not|cannot|can't|won't|do not|don't)\b/i;
const AGENT_NARRATION_ACTION_KEYWORDS =
  /\b(?:will|can|should|could)\b[\s\S]{0,40}\b(?:suggest|share|send|propose|find|follow up|respond)\b/i;
const AGENT_INVOCATION_ACTION_KEYWORDS =
  /\b(?:find|suggest|share|send|propose|book|schedule|check|look|show|slot|time|availability|invite|meet|meeting|calendar|sync|coordinate)\b/i;
const AGENT_INVOCATION_TEMPORAL_SIGNAL_KEYWORDS =
  /\b(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|today|tomorrow|this\s+week|next\s+week|this\s+month|next\s+month|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i;
const AGENT_LLM_INVOCATION_HINT_KEYWORDS =
  /\b(?:cc(?:ing)?|copy(?:ing)?|add(?:ing)?|include|including|loop(?:ing)?\s+in|bring(?:ing)?\s+in|introduc(?:e|ing)|with)\b[\s\S]{0,60}\b(?:assistant|agent|scheduler|calendar\s+agent)\b/i;
const AGENT_ROLE_REFERENCE_HINT_KEYWORDS = /\b(?:my|our|the)\s+(?:assistant|agent|scheduler|calendar\s+agent)\b/i;
const CALENDAR_STATUS_SUBJECT_PATTERN =
  /^(?:\[[^\]]+\]\s*)*(?:re:\s*)?(accepted|declined|tentative|canceled|cancelled)\s*:/i;
const CALENDAR_STATUS_SUBJECT_CONTEXT_PATTERN =
  /\s@\s|\((?:[^()]{2,})\)\s*$|\b(?:gmt|utc)\b|\b\d{1,2}:\d{2}\b/i;
const CALENDAR_STATUS_BODY_HINT_PATTERN =
  /\b(?:invitation|meeting)\b[\s\S]{0,40}\b(?:accepted|declined|tentative|response)\b|\bmethod\s*:\s*reply\b|begin:vcalendar/i;
const AGENT_REFERENCE_STOPWORDS = new Set([
  "agent",
  "assistant",
  "calendar",
  "calendar agent",
  "scheduler",
  "ai"
]);
const PROMPT_GUARD_ALLOWED_MODES = new Set(["off", "heuristic", "llm", "heuristic_llm"]);
const QUOTED_THREAD_BOUNDARY_PATTERNS = [
  /^on .+wrote:\s*$/i,
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^-{2,}\s*forwarded message\s*-{2,}$/i,
  /^from:\s.+@/i,
  /^sent:\s/i,
  /^to:\s.+@/i,
  /^subject:\s/i
];
const EMAIL_ADDRESS_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const DEFAULT_INVITE_SUBJECT_LLM_CONFIDENCE_THRESHOLD = 0.75;

function parseIntEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseClampedIntEnv(value, fallback, minimum, maximum) {
  const parsed = parseIntEnv(value, fallback);
  return Math.min(Math.max(parsed, minimum), maximum);
}

function normalizeTimezone(value, fallbackTimezone) {
  const candidate = String(value ?? "").trim();
  if (!candidate) {
    return fallbackTimezone;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date("2026-01-01T00:00:00Z"));
    return candidate;
  } catch {
    return fallbackTimezone;
  }
}

function normalizePromptGuardMode(value) {
  const candidate = String(value ?? "")
    .trim()
    .toLowerCase();
  if (PROMPT_GUARD_ALLOWED_MODES.has(candidate)) {
    return candidate;
  }

  return DEFAULT_PROMPT_GUARD_MODE;
}

function normalizePromptGuardLevel(value, fallback = DEFAULT_PROMPT_GUARD_BLOCK_LEVEL) {
  const candidate = String(value ?? "")
    .trim()
    .toLowerCase();
  if (Object.hasOwn(PROMPT_GUARD_LEVEL_RANK, candidate)) {
    return candidate;
  }

  return fallback;
}

function mergePromptGuardSignals({ heuristicSignals, llmSignals }) {
  const merged = [];
  const seen = new Set();
  for (const signal of [...heuristicSignals, ...llmSignals]) {
    const normalized = String(signal ?? "")
      .trim()
      .toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    merged.push(normalized);
    seen.add(normalized);
    if (merged.length >= 8) {
      break;
    }
  }

  return merged;
}

function toNonNegativeInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.trunc(parsed));
}

function createLlmUsageAccumulator() {
  return {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    provider: "",
    model: ""
  };
}

function normalizeLlmTelemetry(rawTelemetry) {
  if (!rawTelemetry || typeof rawTelemetry !== "object") {
    return null;
  }

  const provider = String(rawTelemetry.provider ?? "")
    .trim()
    .toLowerCase();
  const model = String(rawTelemetry.model ?? "").trim();
  const inputTokens = toNonNegativeInteger(rawTelemetry.inputTokens);
  const outputTokens = toNonNegativeInteger(rawTelemetry.outputTokens);
  const totalTokens = toNonNegativeInteger(rawTelemetry.totalTokens || inputTokens + outputTokens);

  if (!provider && !model && inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
    return null;
  }

  return {
    provider,
    model,
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function accumulateLlmTelemetry(accumulator, rawTelemetry) {
  const normalized = normalizeLlmTelemetry(rawTelemetry);
  if (!normalized) {
    return;
  }

  accumulator.requestCount += 1;
  accumulator.inputTokens += normalized.inputTokens;
  accumulator.outputTokens += normalized.outputTokens;
  accumulator.totalTokens += normalized.totalTokens;
  if (!accumulator.provider && normalized.provider) {
    accumulator.provider = normalized.provider;
  }
  if (!accumulator.model && normalized.model) {
    accumulator.model = normalized.model;
  }
}

function buildLlmTraceUsageFields(accumulator) {
  return {
    llmRequestCount: toNonNegativeInteger(accumulator.requestCount),
    llmInputTokens: toNonNegativeInteger(accumulator.inputTokens),
    llmOutputTokens: toNonNegativeInteger(accumulator.outputTokens),
    llmTotalTokens: toNonNegativeInteger(accumulator.totalTokens),
    llmProvider: String(accumulator.provider || "").trim(),
    llmModel: String(accumulator.model || "").trim()
  };
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

function normalizeAgentReferenceTerm(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 64);
}

function deriveReferenceTermsFromEmail(email) {
  const normalizedEmail = normalizeEmailAddress(email);
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    return [];
  }

  const [localPart] = normalizedEmail.split("@");
  const normalizedLocalPart = String(localPart ?? "")
    .trim()
    .toLowerCase();
  if (!normalizedLocalPart) {
    return [];
  }

  const terms = [normalizedLocalPart];
  const spaced = normalizeAgentReferenceTerm(normalizedLocalPart);
  if (spaced) {
    terms.push(spaced);
    if (spaced.endsWith(" agent")) {
      terms.push(spaced.slice(0, -" agent".length));
    }
  }

  return terms.filter(Boolean);
}

function deriveAgentReferenceTerms({
  agentDisplayName,
  configuredAgentEmail,
  senderEmail,
  inboundAgentEmail
}) {
  const terms = new Set();

  const addTerm = (rawValue) => {
    const normalized = normalizeAgentReferenceTerm(rawValue);
    if (!normalized || normalized.length < 3 || AGENT_REFERENCE_STOPWORDS.has(normalized)) {
      return;
    }
    terms.add(normalized);
  };

  addTerm(agentDisplayName);

  for (const emailValue of [configuredAgentEmail, senderEmail, inboundAgentEmail]) {
    for (const term of deriveReferenceTermsFromEmail(emailValue)) {
      addTerm(term);
    }
  }

  return [...terms];
}

function lineMentionsAgentReference(line, agentReferenceTerms) {
  const normalizedLine = String(line ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalizedLine) {
    return false;
  }

  for (const term of agentReferenceTerms) {
    if (!term) {
      continue;
    }
    if (normalizedLine.includes(term)) {
      return true;
    }
  }

  return false;
}

function detectExplicitAgentInvocation({
  subject,
  latestReplyText,
  fullBodyText,
  agentReferenceTerms
}) {
  if (!Array.isArray(agentReferenceTerms) || agentReferenceTerms.length === 0) {
    return {
      invoked: false,
      matchedTerm: "",
      matchedLine: "",
      source: "none"
    };
  }

  const candidates = [
    {
      source: "latest_reply",
      text: String(latestReplyText ?? "").trim()
    },
    {
      source: "subject",
      text: String(subject ?? "").trim()
    },
    {
      source: "full_body",
      text: String(fullBodyText ?? "").trim()
    }
  ];

  for (const candidate of candidates) {
    if (!candidate.text) {
      continue;
    }

    const lines = candidate.text
      .replace(/\r\n/g, "\n")
      .split("\n");
    let hasAgentReference = false;
    let hasAffirmativeTemporalSignal = false;
    for (const line of lines) {
      const normalizedLine = String(line ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!normalizedLine) {
        continue;
      }

      const lowerLine = normalizedLine.toLowerCase();
      if (
        AFFIRMATIVE_BOOKING_INTENT_KEYWORDS.test(normalizedLine) &&
        AGENT_INVOCATION_TEMPORAL_SIGNAL_KEYWORDS.test(normalizedLine)
      ) {
        hasAffirmativeTemporalSignal = true;
      }
      for (const term of agentReferenceTerms) {
        if (!term || !lowerLine.includes(term)) {
          continue;
        }
        hasAgentReference = true;
        if (AGENT_INVOCATION_ACTION_KEYWORDS.test(normalizedLine) || /\?/.test(normalizedLine)) {
          return {
            invoked: true,
            matchedTerm: term,
            matchedLine: normalizedLine.slice(0, 240),
            source: candidate.source
          };
        }
      }
    }

    if (hasAgentReference && hasAffirmativeTemporalSignal) {
      return {
        invoked: true,
        matchedTerm: "multi_line_context",
        matchedLine: candidate.text.replace(/\s+/g, " ").trim().slice(0, 240),
        source: candidate.source
      };
    }
  }

  return {
    invoked: false,
    matchedTerm: "",
    matchedLine: "",
    source: "none"
  };
}

function hasLlmInvocationHint({
  subject,
  latestReplyText,
  fullBodyText,
  agentReferenceTerms
}) {
  const candidates = [
    String(latestReplyText ?? "").trim(),
    String(subject ?? "").trim(),
    String(fullBodyText ?? "").trim()
  ].filter(Boolean);

  for (const candidateText of candidates) {
    const normalizedText = String(candidateText).trim();
    if (!normalizedText) {
      continue;
    }

    if (
      AGENT_LLM_INVOCATION_HINT_KEYWORDS.test(normalizedText) ||
      AGENT_ROLE_REFERENCE_HINT_KEYWORDS.test(normalizedText)
    ) {
      return true;
    }

    const lines = normalizedText
      .replace(/\r\n/g, "\n")
      .split("\n");
    for (const line of lines) {
      if (lineMentionsAgentReference(line, agentReferenceTerms)) {
        return true;
      }
    }
  }

  return false;
}

function hasAgentNarrationBookingContext({ mergedText, agentReferenceTerms }) {
  if (!Array.isArray(agentReferenceTerms) || agentReferenceTerms.length === 0) {
    return false;
  }

  const lines = String(mergedText ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n");

  return lines.some(
    (line) =>
      lineMentionsAgentReference(line, agentReferenceTerms) &&
      AGENT_NARRATION_ACTION_KEYWORDS.test(line)
  );
}

function hasBookingIntent({ subject, body, normalizedRequestedWindows, agentReferenceTerms = [] }) {
  if (!Array.isArray(normalizedRequestedWindows) || normalizedRequestedWindows.length === 0) {
    return false;
  }

  const merged = `${String(subject ?? "")}\n${String(body ?? "")}`;
  if (hasAgentNarrationBookingContext({ mergedText: merged, agentReferenceTerms })) {
    return false;
  }

  if (EXPLICIT_BOOKING_INTENT_KEYWORDS.test(merged)) {
    return true;
  }

  if (!AFFIRMATIVE_BOOKING_INTENT_KEYWORDS.test(merged)) {
    return false;
  }

  if (NEGATIVE_BOOKING_INTENT_KEYWORDS.test(merged)) {
    return false;
  }

  // Avoid auto-booking for tentative or interrogative phrasing.
  if (/\?/.test(merged)) {
    return false;
  }

  return true;
}

function hasSpecificBookingCandidate({ normalizedRequestedWindows, durationMinutes }) {
  if (!Array.isArray(normalizedRequestedWindows) || normalizedRequestedWindows.length === 0) {
    return false;
  }

  // Broad windows (for example month/week/day ranges) should not auto-book.
  if (normalizedRequestedWindows.length > 3) {
    return false;
  }

  const normalizedDurationMinutes = Math.max(15, Number.parseInt(durationMinutes ?? 30, 10) || 30);
  const maxWindowMinutes = Math.max(normalizedDurationMinutes * 4, 120);
  for (const window of normalizedRequestedWindows) {
    const startMs = Date.parse(window?.startIso);
    const endMs = Date.parse(window?.endIso);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      return false;
    }

    const spanMinutes = (endMs - startMs) / (60 * 1000);
    if (spanMinutes > maxWindowMinutes) {
      return false;
    }
  }

  return true;
}

function normalizeMeetingLinkProvider(value, fallback = DEFAULT_MEETING_LINK_PROVIDER) {
  const candidate = String(value ?? "")
    .trim()
    .toLowerCase();
  if (SUPPORTED_MEETING_LINK_PROVIDERS.has(candidate)) {
    return candidate;
  }
  return fallback;
}

function resolveStaticMeetingUrl(env) {
  return String(env.CALENDAR_INVITE_MEETING_URL ?? "").trim();
}

function sanitizeMeetingLinkErrorMessage(value) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }

  const redacted = normalized
    .replace(
      /("?(?:access_token|refresh_token|client_secret|id_token)"?\s*[:=]\s*"?)([^",\s}]+)/gi,
      "$1[redacted]"
    )
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted]");

  return redacted.slice(0, MEETING_LINK_ERROR_MESSAGE_MAX_LENGTH);
}

function deriveMeetingLinkErrorCode({ provider, status, error }) {
  const normalizedProvider = String(provider ?? "unknown")
    .trim()
    .toLowerCase();
  const codeProvider =
    normalizedProvider === "google_meet" ? "google" : normalizedProvider === "static_url" ? "static" : normalizedProvider;
  const normalizedStatus = String(status ?? "failed")
    .trim()
    .toLowerCase();
  const rawMessage = String(error?.message ?? "");
  const normalizedMessage = rawMessage.toLowerCase();
  const httpCodeMatch = rawMessage.match(/\((\d{3})\)/);
  if (httpCodeMatch) {
    return `${codeProvider}_http_${httpCodeMatch[1]}`;
  }

  if (normalizedMessage.includes("token refresh failed")) {
    return `${codeProvider}_token_refresh_failed`;
  }
  if (normalizedMessage.includes("missing")) {
    return `${codeProvider}_oauth_missing`;
  }
  if (normalizedMessage.includes("response missing")) {
    return `${codeProvider}_response_invalid`;
  }
  return `${codeProvider}_${normalizedStatus}`;
}

function summarizeMeetingLinkError({ provider, status, error }) {
  return {
    errorCode: deriveMeetingLinkErrorCode({ provider, status, error }),
    errorMessage: sanitizeMeetingLinkErrorMessage(error?.message ?? "")
  };
}

function selectGoogleConnectionForMeetingLink({ activeConnection, connectedConnections }) {
  if (activeConnection?.provider === "google" && activeConnection?.secretArn) {
    return activeConnection;
  }

  const googleConnection = (Array.isArray(connectedConnections) ? connectedConnections : []).find(
    (connection) =>
      String(connection?.provider ?? "").toLowerCase() === "google" &&
      String(connection?.status ?? "").toLowerCase() === "connected" &&
      Boolean(connection?.secretArn)
  );
  return googleConnection ?? null;
}

async function resolveMeetingLinkForInvite({
  env,
  deps,
  advisorSettings,
  selectedSlotStartIsoUtc,
  durationMinutes,
  hostTimezone,
  inviteSubject,
  calendarMode,
  activeConnection,
  connectedConnections
}) {
  const provider = normalizeMeetingLinkProvider(
    advisorSettings?.meetingProvider ?? env.MEETING_LINK_PROVIDER,
    DEFAULT_MEETING_LINK_PROVIDER
  );
  const staticMeetingUrl = resolveStaticMeetingUrl(env);

  if (provider === "static_url") {
    return {
      provider,
      meetingUrl: staticMeetingUrl,
      status: staticMeetingUrl ? "static_url" : "static_url_missing",
      errorCode: staticMeetingUrl ? "" : "static_url_missing",
      errorMessage: staticMeetingUrl ? "" : "CALENDAR_INVITE_MEETING_URL is empty"
    };
  }

  if (provider === "google_meet") {
    try {
      let oauthConfig = null;
      const googleConnection = selectGoogleConnectionForMeetingLink({
        activeConnection,
        connectedConnections
      });
      if (googleConnection?.secretArn) {
        const secretString = await deps.getSecretString(googleConnection.secretArn);
        oauthConfig = parseGoogleOauthSecret(secretString);
      } else if (calendarMode === "google" && env.GOOGLE_OAUTH_SECRET_ARN) {
        const secretString = await deps.getSecretString(env.GOOGLE_OAUTH_SECRET_ARN);
        oauthConfig = parseGoogleOauthSecret(secretString);
      }

      if (!oauthConfig) {
        return {
          provider,
          meetingUrl: staticMeetingUrl,
          status: "google_oauth_missing",
          errorCode: "google_oauth_missing",
          errorMessage: "Google OAuth credentials are missing for meeting link creation"
        };
      }

      const accessToken = await exchangeRefreshToken({
        clientId: oauthConfig.clientId,
        clientSecret: oauthConfig.clientSecret,
        refreshToken: oauthConfig.refreshToken,
        fetchImpl: deps.fetchImpl
      });
      const meet = await createGoogleMeetSpace({
        accessToken,
        fetchImpl: deps.fetchImpl
      });

      return {
        provider,
        meetingUrl: meet.meetingUrl,
        status: "google_created",
        errorCode: "",
        errorMessage: ""
      };
    } catch (error) {
      const summary = summarizeMeetingLinkError({
        provider,
        status: "create_failed",
        error
      });
      return {
        provider,
        meetingUrl: staticMeetingUrl,
        status: "google_create_failed",
        errorCode: summary.errorCode,
        errorMessage: summary.errorMessage
      };
    }
  }

  if (provider === "zoom") {
    try {
      const zoomMeetingSecretArn = String(advisorSettings?.zoomMeetingSecretArn ?? "").trim();
      const zoomAppSecretArn = String(env.ZOOM_OAUTH_APP_SECRET_ARN ?? "").trim();
      if (!zoomMeetingSecretArn || !zoomAppSecretArn) {
        return {
          provider,
          meetingUrl: staticMeetingUrl,
          status: "zoom_oauth_missing",
          errorCode: "zoom_oauth_missing",
          errorMessage: "Zoom OAuth credentials are missing for meeting link creation"
        };
      }

      const [zoomAppSecretString, zoomMeetingSecretString] = await Promise.all([
        deps.getSecretString(zoomAppSecretArn),
        deps.getSecretString(zoomMeetingSecretArn)
      ]);
      const zoomApp = parseZoomAppSecret(zoomAppSecretString);
      const zoomMeetingSecret = parseZoomMeetingSecret(zoomMeetingSecretString);
      const zoomTokenPayload = await exchangeZoomRefreshToken({
        clientId: zoomApp.clientId,
        clientSecret: zoomApp.clientSecret,
        refreshToken: zoomMeetingSecret.refreshToken,
        fetchImpl: deps.fetchImpl
      });

      if (
        zoomTokenPayload.refreshToken &&
        zoomTokenPayload.refreshToken !== zoomMeetingSecret.refreshToken &&
        typeof deps.putSecretValue === "function"
      ) {
        const refreshedSecretPayload = JSON.stringify({
          refresh_token: zoomTokenPayload.refreshToken,
          account_email: zoomMeetingSecret.accountEmail ?? ""
        });
        try {
          await deps.putSecretValue(zoomMeetingSecretArn, refreshedSecretPayload);
        } catch (tokenPersistError) {
          // Non-fatal: invite creation should proceed even if refresh token rotation persistence fails.
          console.warn(
            `[meeting-link][zoom] refresh token rotation persist failed: ${sanitizeMeetingLinkErrorMessage(
              tokenPersistError?.message
            )}`
          );
        }
      }

      const zoomMeeting = await createZoomMeeting({
        accessToken: zoomTokenPayload.accessToken,
        topic: inviteSubject,
        startIsoUtc: selectedSlotStartIsoUtc,
        durationMinutes,
        timezone: hostTimezone,
        fetchImpl: deps.fetchImpl
      });

      return {
        provider,
        meetingUrl: zoomMeeting.meetingUrl,
        status: "zoom_created",
        errorCode: "",
        errorMessage: ""
      };
    } catch (error) {
      const summary = summarizeMeetingLinkError({
        provider,
        status: "create_failed",
        error
      });
      return {
        provider,
        meetingUrl: staticMeetingUrl,
        status: "zoom_create_failed",
        errorCode: summary.errorCode,
        errorMessage: summary.errorMessage
      };
    }
  }

  return {
    provider: "unknown",
    meetingUrl: staticMeetingUrl,
    status: "provider_unrecognized",
    errorCode: "provider_unrecognized",
    errorMessage: "Meeting link provider is not recognized"
  };
}

function isCalendarStatusMessage({ subject, bodyText }) {
  const normalizedSubject = String(subject ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedSubject || !CALENDAR_STATUS_SUBJECT_PATTERN.test(normalizedSubject)) {
    return false;
  }

  if (CALENDAR_STATUS_SUBJECT_CONTEXT_PATTERN.test(normalizedSubject)) {
    return true;
  }

  const normalizedBody = String(bodyText ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedBody) {
    return false;
  }

  return CALENDAR_STATUS_BODY_HINT_PATTERN.test(normalizedBody);
}

function buildBookingIntentTraceFields({
  bookingIntentSource,
  llmBookingIntent,
  llmBookingIntentConfidence
}) {
  const normalizedSource = String(bookingIntentSource ?? "deterministic").trim() || "deterministic";
  const confidenceValue = Number(llmBookingIntentConfidence);
  const normalizedConfidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0;
  const normalizedLlmValue = typeof llmBookingIntent === "boolean" ? String(llmBookingIntent) : "unknown";

  return {
    bookingIntentSource: normalizedSource,
    bookingIntentLlmValue: normalizedLlmValue,
    bookingIntentLlmConfidence: normalizedConfidence
  };
}

function isQuotedThreadBoundaryLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith(">")) {
    return true;
  }

  return QUOTED_THREAD_BOUNDARY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function extractLatestReplyText(bodyText) {
  const normalizedBody = String(bodyText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!normalizedBody) {
    return "";
  }

  const lines = normalizedBody.split("\n");
  const boundaryIndex = lines.findIndex((line) => isQuotedThreadBoundaryLine(line));
  const latestReplyLines = boundaryIndex >= 0 ? lines.slice(0, boundaryIndex) : lines;
  while (latestReplyLines.length > 0 && latestReplyLines[latestReplyLines.length - 1].trim() === "") {
    latestReplyLines.pop();
  }

  const latestReplyText = latestReplyLines.join("\n").trim();
  if (latestReplyText) {
    return latestReplyText;
  }

  const nonQuotedLines = lines.filter((line) => !String(line ?? "").trim().startsWith(">"));
  const nonQuotedText = nonQuotedLines.join("\n").trim();
  return nonQuotedText;
}

function extractQuotedThreadContext(bodyText) {
  const normalizedBody = String(bodyText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!normalizedBody) {
    return "";
  }

  const lines = normalizedBody.split("\n");
  const boundaryIndex = lines.findIndex((line) => isQuotedThreadBoundaryLine(line));
  if (boundaryIndex >= 0 && boundaryIndex < lines.length) {
    return lines.slice(boundaryIndex).join("\n").trim();
  }

  const quotedLines = lines.filter((line) => String(line ?? "").trim().startsWith(">"));
  return quotedLines.join("\n").trim();
}

function buildThreadAwareIntentBody({ latestReplyText, quotedThreadContext }) {
  const latest = String(latestReplyText ?? "").trim();
  const context = String(quotedThreadContext ?? "").trim();
  if (!context) {
    return latest;
  }
  if (!latest) {
    return context;
  }

  return [
    "LATEST_CLIENT_REPLY:",
    latest,
    "",
    "EARLIER_THREAD_CONTEXT:",
    context
  ].join("\n");
}

function buildThreadAwareParserBody({ latestReplyText, quotedThreadContext }) {
  const latest = String(latestReplyText ?? "").trim();
  const context = String(quotedThreadContext ?? "").trim();
  if (!latest && !context) {
    return "";
  }
  if (!context) {
    return latest;
  }
  if (!latest) {
    return context;
  }

  return `${latest}\n\n${context}`;
}

function buildIntentTraceFields({
  intentInputMode,
  intentInputLength,
  intentLlmWindowCount,
  intentLlmRetryUsed
}) {
  return {
    intentInputMode: String(intentInputMode ?? "full_body"),
    intentInputLength: toNonNegativeInteger(intentInputLength),
    intentLlmWindowCount: toNonNegativeInteger(intentLlmWindowCount),
    intentLlmRetryUsed: Boolean(intentLlmRetryUsed)
  };
}

function uniqueEmails(items) {
  const deduped = new Set();
  for (const item of items) {
    const normalized = normalizeEmailAddress(item);
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
  }

  return [...deduped];
}

function formatDateUtcForIcs(isoUtc) {
  const parsed = DateTime.fromISO(String(isoUtc ?? ""), { zone: "utc" });
  if (!parsed.isValid) {
    return "";
  }

  return parsed.toFormat("yyyyLLdd'T'HHmmss'Z'");
}

function escapeIcsText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function foldIcsLine(line) {
  const maxLength = 73;
  if (line.length <= maxLength) {
    return line;
  }

  let remaining = line;
  const folded = [];
  while (remaining.length > maxLength) {
    folded.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }
  folded.push(remaining);
  return folded.join("\r\n ");
}

function buildIcsInvite({
  uid,
  nowIso,
  startIsoUtc,
  endIsoUtc,
  summary,
  description,
  location,
  meetingUrl,
  organizerEmail,
  organizerName,
  attendeeEmails
}) {
  const dtStamp = formatDateUtcForIcs(nowIso);
  const dtStart = formatDateUtcForIcs(startIsoUtc);
  const dtEnd = formatDateUtcForIcs(endIsoUtc);
  const normalizedSummary = escapeIcsText(summary);
  const normalizedDescription = escapeIcsText(description);
  const normalizedLocation = escapeIcsText(location);
  const normalizedMeetingUrl = String(meetingUrl ?? "").trim();
  const normalizedOrganizerName = escapeIcsText(organizerName);
  const normalizedOrganizerEmail = normalizeEmailAddress(organizerEmail);

  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//LetsConnect.ai//Calendar Agent//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${normalizedSummary}`,
    `DESCRIPTION:${normalizedDescription}`,
    ...(normalizedLocation ? [`LOCATION:${normalizedLocation}`] : []),
    ...(normalizedMeetingUrl ? [`URL:${escapeIcsText(normalizedMeetingUrl)}`] : []),
    `ORGANIZER;CN=${normalizedOrganizerName}:mailto:${normalizedOrganizerEmail}`,
    "SEQUENCE:0",
    "STATUS:CONFIRMED"
  ];

  for (const attendeeEmail of attendeeEmails) {
    const normalizedAttendeeEmail = normalizeEmailAddress(attendeeEmail);
    if (!normalizedAttendeeEmail) {
      continue;
    }

    lines.push(`ATTENDEE;CN=${escapeIcsText(normalizedAttendeeEmail)};RSVP=TRUE:mailto:${normalizedAttendeeEmail}`);
  }

  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

function formatInviteLabel(isoUtc, timezone) {
  const date = new Date(isoUtc);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short"
  }).format(date);
}

function normalizeInviteParticipantName(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, 64);
}

function buildFallbackInviteSubject({ clientDisplayName, advisorDisplayName }) {
  const clientName = normalizeInviteParticipantName(clientDisplayName);
  const advisorName = normalizeInviteParticipantName(advisorDisplayName);

  if (clientName && advisorName) {
    return `Meeting ${clientName}/${advisorName}`;
  }
  if (clientName) {
    return `Meeting ${clientName}`;
  }
  if (advisorName) {
    return `Meeting ${advisorName}`;
  }

  return "Meeting request";
}

function buildCalendarInviteMessage({
  subject,
  selectedSlot,
  hostTimezone,
  clientTimezone,
  meetingUrl,
  agentDisplayName,
  senderEmail,
  attendeeEmails,
  requestId,
  nowIso,
  inviteTitle,
  inviteDescription
}) {
  const hostLabel = formatInviteLabel(selectedSlot.startIsoUtc, hostTimezone);
  const clientLabel = clientTimezone ? formatInviteLabel(selectedSlot.startIsoUtc, clientTimezone) : null;
  const normalizedSubject = String(subject ?? "").trim();
  const safeTitle =
    normalizedSubject ||
    String(inviteTitle ?? DEFAULT_CALENDAR_INVITE_TITLE).trim() ||
    DEFAULT_CALENDAR_INVITE_TITLE;
  const normalizedMeetingUrl = String(meetingUrl ?? "").trim();
  const locationLabel = normalizedMeetingUrl ? `Meeting link: ${normalizedMeetingUrl}` : "";
  const safeDescription =
    String(inviteDescription ?? "").trim() ||
    [
      `Scheduled via LetsConnect.ai. Advisor timezone: ${hostTimezone}.`,
      normalizedMeetingUrl ? `Join URL: ${normalizedMeetingUrl}.` : null
    ]
      .filter(Boolean)
      .join(" ");
  const meetingUid = `${requestId}@letsconnect.ai`;

  const bodyLines = [
    `I have prepared a calendar invite for ${hostLabel}.`,
    clientLabel ? `Your local time: ${clientLabel}.` : null,
    normalizedMeetingUrl ? `Join meeting: ${normalizedMeetingUrl}` : null,
    "Please accept the invite in your calendar app."
  ].filter(Boolean);

  const icsContent = buildIcsInvite({
    uid: meetingUid,
    nowIso,
    startIsoUtc: selectedSlot.startIsoUtc,
    endIsoUtc: selectedSlot.endIsoUtc,
    summary: safeTitle,
    description: safeDescription,
    location: locationLabel,
    meetingUrl: normalizedMeetingUrl,
    organizerEmail: senderEmail,
    organizerName: String(agentDisplayName ?? "").trim() || "Agent",
    attendeeEmails
  });

  return {
    subject: normalizedSubject || "Meeting request",
    bodyText: bodyLines.join("\n"),
    icsContent
  };
}

function buildBookingConfirmationMessage({
  subject,
  selectedSlot,
  hostTimezone,
  clientTimezone,
  meetingUrl
}) {
  const hostLabel = formatInviteLabel(selectedSlot.startIsoUtc, hostTimezone);
  const clientLabel = clientTimezone ? formatInviteLabel(selectedSlot.startIsoUtc, clientTimezone) : null;
  const normalizedMeetingUrl = String(meetingUrl ?? "").trim();
  const lines = [
    `Thanks for confirming. I am about to send a calendar invite for ${hostLabel}.`,
    clientLabel ? `Your local time: ${clientLabel}.` : null,
    normalizedMeetingUrl ? `The invite will include this meeting link: ${normalizedMeetingUrl}` : null
  ].filter(Boolean);

  return {
    subject: `Re: ${subject || "Meeting request"}`,
    bodyText: lines.join("\n")
  };
}

function detectRequestedDaypart(subject, body) {
  const text = `${String(subject ?? "")}\n${String(body ?? "")}`.toLowerCase();
  const matches = Array.from(text.matchAll(DAYPART_PATTERN), (match) => String(match[1] ?? "").trim());
  if (matches.length === 0) {
    return null;
  }

  const uniqueMatches = Array.from(new Set(matches));
  if (uniqueMatches.length !== 1) {
    return null;
  }

  const daypart = uniqueMatches[0];
  return Object.hasOwn(DAYPART_WINDOWS, daypart) ? daypart : null;
}

function constrainRequestedWindowsToDaypart({ requestedWindows, daypart, timezone }) {
  const daypartWindow = DAYPART_WINDOWS[daypart];
  if (!daypartWindow || !Array.isArray(requestedWindows) || requestedWindows.length === 0) {
    return requestedWindows;
  }

  const targetZone = timezone || "UTC";
  const constrainedWindows = [];

  for (const window of requestedWindows) {
    const startUtc = DateTime.fromISO(window.startIso, { zone: "utc" });
    const endUtc = DateTime.fromISO(window.endIso, { zone: "utc" });
    if (!startUtc.isValid || !endUtc.isValid || endUtc <= startUtc) {
      continue;
    }

    const startLocal = startUtc.setZone(targetZone);
    const endLocal = endUtc.setZone(targetZone);
    let dayCursor = startLocal.startOf("day");
    const lastDay = endLocal.startOf("day");
    while (dayCursor <= lastDay) {
      const daypartStart = dayCursor.startOf("day").plus({ minutes: daypartWindow.startMinute });
      const daypartEnd = dayCursor.startOf("day").plus({ minutes: daypartWindow.endMinute });
      const effectiveStart = daypartStart > startLocal ? daypartStart : startLocal;
      const effectiveEnd = daypartEnd < endLocal ? daypartEnd : endLocal;
      if (effectiveEnd > effectiveStart) {
        constrainedWindows.push({
          startIso: effectiveStart.toUTC().toISO(),
          endIso: effectiveEnd.toUTC().toISO()
        });
      }

      dayCursor = dayCursor.plus({ days: 1 });
    }
  }

  return normalizeRequestedWindowsToUtc(constrainedWindows);
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

function computeAvailabilityWeekOffset({
  issuedAtMs,
  hostTimezone,
  firstSuggestedSlotStartIsoUtc
}) {
  const suggestedStartRaw = String(firstSuggestedSlotStartIsoUtc ?? "").trim();
  if (!suggestedStartRaw) {
    return null;
  }

  const suggestedStartUtc = DateTime.fromISO(suggestedStartRaw, { zone: "utc" });
  if (!suggestedStartUtc.isValid) {
    return null;
  }

  const timezone = normalizeTimezone(hostTimezone, DEFAULT_ADVISOR_TIMEZONE);
  const baseWeekStartLocal = DateTime.fromMillis(issuedAtMs, { zone: timezone }).startOf("week");
  const suggestedWeekStartLocal = suggestedStartUtc.setZone(timezone).startOf("week");
  const rawWeekOffset = suggestedWeekStartLocal.diff(baseWeekStartLocal, "weeks").weeks;
  if (!Number.isFinite(rawWeekOffset)) {
    return null;
  }

  // Keep range aligned with portal `parseWeekOffset`.
  return Math.min(Math.max(Math.trunc(rawWeekOffset), -8), 52);
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

function buildThreadReplySubject(originalSubject, fallback = "Meeting request") {
  const sanitized = String(originalSubject ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (sanitized) {
    return sanitized;
  }

  const normalizedFallback = String(fallback ?? "").trim() || "Meeting request";
  return `Re: ${normalizedFallback}`;
}

function normalizeHeaderValueForThread(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function extractMessageIdTokens(rawValue) {
  const normalized = normalizeHeaderValueForThread(rawValue);
  if (!normalized) {
    return [];
  }

  const bracketedMatches = normalized.match(/<[^<>]+>/g);
  if (Array.isArray(bracketedMatches) && bracketedMatches.length > 0) {
    return bracketedMatches.map((item) => item.trim()).filter(Boolean);
  }

  const token = normalized.split(/[\s,]+/).find(Boolean);
  if (!token) {
    return [];
  }

  const cleaned = token.replace(/^<+|>+$/g, "").trim();
  if (!cleaned) {
    return [];
  }

  return [cleaned.includes("@") ? `<${cleaned}>` : cleaned];
}

function normalizeThreadMessageIdValue(rawValue) {
  const candidates = Array.isArray(rawValue)
    ? rawValue.flatMap((item) => extractMessageIdTokens(item))
    : extractMessageIdTokens(rawValue);
  return candidates[0] ?? "";
}

function normalizeThreadMessageIdList(rawValue) {
  const values = Array.isArray(rawValue) ? rawValue : [rawValue];
  const deduped = [];
  for (const value of values) {
    for (const token of extractMessageIdTokens(value)) {
      if (!token || deduped.includes(token)) {
        continue;
      }
      deduped.push(token);
    }
  }
  return deduped;
}

function normalizeReferencesHeaderValue(referencesList) {
  const maxReferences = 30;
  const clampedList = referencesList.slice(-maxReferences);
  const joined = clampedList.join(" ").trim();
  if (!joined) {
    return "";
  }

  return joined.length > 1800 ? joined.slice(joined.length - 1800) : joined;
}

function buildOutboundThreadHeaders({ payload, mimeMessageId, mimeInReplyTo, mimeReferences }) {
  const payloadMessageId = normalizeThreadMessageIdValue(payload?.messageId);
  const payloadInReplyTo = normalizeThreadMessageIdValue(payload?.inReplyTo);
  const payloadReferences = normalizeThreadMessageIdList(payload?.references);

  const messageId = normalizeThreadMessageIdValue(mimeMessageId) || payloadMessageId;
  const inReplyTo = normalizeThreadMessageIdValue(mimeInReplyTo) || payloadInReplyTo;
  const references = normalizeThreadMessageIdList([
    ...(Array.isArray(mimeReferences) ? mimeReferences : [mimeReferences]),
    ...payloadReferences
  ]);

  const replyAnchor = messageId || inReplyTo;
  if (!replyAnchor && references.length === 0) {
    return null;
  }

  const mergedReferences = [];
  for (const token of [...references, inReplyTo, messageId]) {
    if (!token || mergedReferences.includes(token)) {
      continue;
    }
    mergedReferences.push(token);
  }

  return {
    inReplyTo: replyAnchor,
    references: normalizeReferencesHeaderValue(mergedReferences)
  };
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

function deriveDisplayNameFromEmail(emailValue) {
  const normalizedEmail = normalizeEmailAddress(emailValue);
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    return "";
  }

  const rawLocalPart = normalizedEmail.split("@")[0];
  const canonicalLocalPart = rawLocalPart.replace(/[._-]agent(?:[._-]\d+)?$/i, "");
  const localPart = String(canonicalLocalPart || rawLocalPart)
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!localPart) {
    return "";
  }

  return titleCaseWords(localPart).slice(0, 64);
}

function deriveAgentDisplayName(rawAgentDisplayName, { configuredAgentEmail, senderEmail, inboundAgentEmail } = {}) {
  const explicitName = String(rawAgentDisplayName ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (explicitName) {
    return explicitName.slice(0, 64);
  }

  for (const emailCandidate of [configuredAgentEmail, inboundAgentEmail, senderEmail]) {
    const derived = deriveDisplayNameFromEmail(emailCandidate);
    if (derived) {
      return derived;
    }
  }

  return "Agent";
}

function ensurePersonalizedGreetingAndSignature({
  responseMessage,
  clientDisplayName,
  agentDisplayName,
  advisorDisplayName
}) {
  const greetingName = String(clientDisplayName ?? "").trim() || "there";
  const signoffName = String(agentDisplayName ?? advisorDisplayName ?? "").trim() || "Agent";
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
  hostTimezone,
  clientTimezone,
  durationMinutes,
  issuedAtMs,
  firstSuggestedSlotStartIsoUtc,
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
  const weekOffset = computeAvailabilityWeekOffset({
    issuedAtMs,
    hostTimezone,
    firstSuggestedSlotStartIsoUtc
  });
  if (weekOffset !== null) {
    availabilityUrl.searchParams.set("weekOffset", String(weekOffset));
  }
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
  const emailMatch = candidate.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  if (emailMatch) {
    return emailMatch[0];
  }

  const stripped = candidate
    .replace(/^mailto:/, "")
    .replace(/[<>]/g, "")
    .trim();
  if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(stripped)) {
    return stripped;
  }

  return "";
}

function sortConnectionsByUpdatedAtDesc(connections) {
  return [...connections].sort((left, right) =>
    String(right?.updatedAt ?? "").localeCompare(String(left?.updatedAt ?? ""))
  );
}

function selectPrimaryConnectionCandidate(connections) {
  const normalized = Array.isArray(connections) ? connections.filter(Boolean) : [];
  if (normalized.length === 0) {
    return null;
  }

  const connected = normalized.filter((connection) => String(connection?.status ?? "").toLowerCase() === "connected");
  if (connected.length === 0) {
    return null;
  }

  const primaryCandidates = connected.filter((connection) => connection?.isPrimary === true);
  const candidates = primaryCandidates.length > 0 ? primaryCandidates : connected;
  return sortConnectionsByUpdatedAtDesc(candidates)[0] ?? null;
}

async function listConnectedCalendarConnections({ deps, connectionsTableName, advisorId }) {
  if (!connectionsTableName) {
    throw new Error("CONNECTIONS_TABLE_NAME is required for CALENDAR_MODE=connection");
  }

  let connections = [];
  if (typeof deps.listConnections === "function") {
    connections = await deps.listConnections(connectionsTableName, advisorId);
  } else if (typeof deps.getPrimaryConnection === "function") {
    // Backward-compatible path for tests/older dependency contracts.
    const primaryConnection = await deps.getPrimaryConnection(connectionsTableName, advisorId);
    connections = primaryConnection ? [primaryConnection] : [];
  } else {
    throw new Error("Connection listing capability is required for CALENDAR_MODE=connection");
  }

  return sortConnectionsByUpdatedAtDesc(
    (Array.isArray(connections) ? connections : []).filter(
      (connection) => String(connection?.status ?? "").toLowerCase() === "connected"
    )
  );
}

function buildAccessDeniedResponseMessage() {
  return {
    subject: "Re: Scheduling request",
    bodyText:
      "This scheduling interface is currently unavailable for your account.\nPlease contact the advisor directly if you need help booking time."
  };
}

function summarizeForAdvisorPreview(rawValue, maxChars = 600) {
  const normalized = String(rawValue ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "(empty)";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 1)}…`;
}

function buildCalendarConnectionRequiredAdvisorMessage({
  originalSubject,
  clientEmail,
  bodyText,
  startedAtIso
}) {
  const safeSubject = String(originalSubject ?? "").trim() || "Meeting request";
  const bodyPreview = summarizeForAdvisorPreview(bodyText, 800);
  return {
    subject: "Action required: connect your calendar to continue scheduling",
    bodyText: [
      "A client scheduling request was received, but the advisor calendar is not connected.",
      "",
      "Please connect a calendar in Advisor Portal, then reply to this client.",
      "",
      `Client: ${clientEmail}`,
      `Subject: ${safeSubject}`,
      `Received (UTC): ${startedAtIso}`,
      `Request preview: ${bodyPreview}`
    ].join("\n")
  };
}

function buildCalendarConnectionRequiredClientHoldMessage(subject) {
  return {
    subject: `Re: ${String(subject ?? "").trim() || "Meeting request"}`,
    bodyText:
      "Thanks for reaching out. I am temporarily unable to access the advisor calendar right now.\n" +
      "I have notified the advisor to reconnect their calendar and will follow up with availability shortly."
  };
}

function buildPromptGuardFallbackResponseMessage() {
  return {
    subject: "Re: Scheduling request",
    bodyText:
      "I could not safely process that message automatically.\nPlease resend using only scheduling details such as preferred days, time windows, timezone, and duration."
  };
}

function extractDomainFromEmail(normalizedEmail) {
  const atIndex = normalizedEmail.lastIndexOf("@");
  if (atIndex < 0 || atIndex === normalizedEmail.length - 1) {
    return "unknown";
  }

  return normalizedEmail.slice(atIndex + 1);
}

function normalizeEmailList(input) {
  if (Array.isArray(input)) {
    const values = [];
    for (const item of input) {
      values.push(...normalizeEmailList(item));
    }
    return values;
  }

  const raw = String(input ?? "").trim();
  if (!raw) {
    return [];
  }

  const matches = raw.match(EMAIL_ADDRESS_PATTERN);
  if (Array.isArray(matches) && matches.length > 0) {
    return [...new Set(matches.map((item) => normalizeEmailAddress(item)).filter(Boolean))];
  }

  const normalized = normalizeEmailAddress(raw);
  return normalized ? [normalized] : [];
}

function extractDestinationEmails(payload) {
  const candidates = [];
  const pushEmail = (value) => {
    const normalizedValues = normalizeEmailList(value);
    for (const normalized of normalizedValues) {
      candidates.push(normalized);
    }
  };

  pushEmail(payload?.toEmail);
  pushEmail(payload?.to);
  pushEmail(payload?.recipient);

  if (Array.isArray(payload?.toEmails)) {
    for (const value of payload.toEmails) {
      pushEmail(value);
    }
  }

  if (Array.isArray(payload?.ccEmails)) {
    for (const value of payload.ccEmails) {
      pushEmail(value);
    }
  }

  if (Array.isArray(payload?.ses?.destination)) {
    for (const value of payload.ses.destination) {
      pushEmail(value);
    }
  }

  if (Array.isArray(payload?.ses?.mail?.destination)) {
    for (const value of payload.ses.mail.destination) {
      pushEmail(value);
    }
  }

  if (Array.isArray(payload?.ses?.receipt?.recipients)) {
    for (const value of payload.ses.receipt.recipients) {
      pushEmail(value);
    }
  }

  return [...new Set(candidates)];
}

function collectRawThreadRecipientAddresses(payload) {
  const rawRecipients = [];
  const pushRaw = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        pushRaw(item);
      }
      return;
    }

    const raw = String(value ?? "").trim();
    if (!raw) {
      return;
    }

    for (const token of raw.split(",")) {
      const candidate = String(token ?? "").trim();
      if (candidate) {
        rawRecipients.push(candidate);
      }
    }
  };

  pushRaw(payload?.toEmail);
  pushRaw(payload?.to);
  pushRaw(payload?.recipient);

  if (Array.isArray(payload?.toEmails)) {
    for (const value of payload.toEmails) {
      pushRaw(value);
    }
  }

  if (Array.isArray(payload?.ccEmails)) {
    for (const value of payload.ccEmails) {
      pushRaw(value);
    }
  }

  if (Array.isArray(payload?.ses?.destination)) {
    for (const value of payload.ses.destination) {
      pushRaw(value);
    }
  }

  if (Array.isArray(payload?.ses?.mail?.destination)) {
    for (const value of payload.ses.mail.destination) {
      pushRaw(value);
    }
  }

  if (Array.isArray(payload?.ses?.receipt?.recipients)) {
    for (const value of payload.ses.receipt.recipients) {
      pushRaw(value);
    }
  }

  return rawRecipients;
}

function collectThreadParticipantEmails({
  payload,
  fromEmail,
  inboundAgentEmail,
  senderEmail
}) {
  const participants = uniqueEmails([
    fromEmail,
    ...extractDestinationEmails(payload)
  ]);
  const exclusions = new Set(
    uniqueEmails([inboundAgentEmail, senderEmail])
  );

  return participants.filter((email) => !exclusions.has(email));
}

function includeAdvisorRecipient({ recipients, advisorNotificationEmail, senderEmail }) {
  const baseRecipients = uniqueEmails(recipients);
  const advisorRecipient = normalizeEmailAddress(advisorNotificationEmail);
  const sender = normalizeEmailAddress(senderEmail);
  if (!advisorRecipient || advisorRecipient === sender) {
    return baseRecipients;
  }

  return uniqueEmails([...baseRecipients, advisorRecipient]);
}

async function sendResponseEmailWithAdvisorCopy({
  deps,
  senderEmail,
  advisorNotificationEmail,
  recipients,
  subject,
  bodyText,
  threadHeaders
}) {
  const finalRecipients = includeAdvisorRecipient({
    recipients,
    advisorNotificationEmail,
    senderEmail
  });
  if (finalRecipients.length <= 1) {
    await deps.sendResponseEmail({
      senderEmail,
      recipientEmail: finalRecipients[0],
      subject,
      bodyText,
      threadHeaders
    });
  } else {
    await deps.sendResponseEmail({
      senderEmail,
      toEmails: finalRecipients,
      subject,
      bodyText,
      threadHeaders
    });
  }
}

function collectAdvisorIdentityEmails({
  advisorSettings,
  advisorInviteEmailOverride,
  senderEmail,
  advisorId,
  env
}) {
  return new Set(
    [
      advisorSettings?.advisorEmail,
      advisorSettings?.inviteEmail,
      advisorInviteEmailOverride,
      env.ADVISOR_EMAIL,
      env.ADVISOR_ALLOWED_EMAIL,
      env.ADVISOR_INVITE_EMAIL,
      senderEmail,
      advisorId
    ]
      .map((item) => normalizeEmailAddress(item))
      .filter(Boolean)
  );
}

function resolveSuggestionAddresseeDisplayName({
  payload,
  isAdvisorSender,
  advisorIdentityEmails,
  inboundAgentEmail,
  senderEmail,
  fallbackDisplayName
}) {
  const fallback = String(fallbackDisplayName ?? "").trim() || "there";
  if (!isAdvisorSender) {
    return fallback;
  }

  const excludedEmails = new Set([
    ...advisorIdentityEmails,
    ...uniqueEmails([inboundAgentEmail, senderEmail])
  ]);
  const rawRecipients = collectRawThreadRecipientAddresses(payload);
  for (const rawRecipient of rawRecipients) {
    const recipientEmail = normalizeEmailAddress(rawRecipient);
    if (!recipientEmail || excludedEmails.has(recipientEmail)) {
      continue;
    }

    return deriveClientDisplayName(rawRecipient, recipientEmail);
  }

  const normalizedRecipients = extractDestinationEmails(payload);
  for (const recipientEmail of normalizedRecipients) {
    if (!recipientEmail || excludedEmails.has(recipientEmail)) {
      continue;
    }

    return deriveClientDisplayName(recipientEmail, recipientEmail);
  }

  return fallback;
}

function resolveSuggestionAddresseeEmail({
  payload,
  isAdvisorSender,
  advisorIdentityEmails,
  inboundAgentEmail,
  senderEmail,
  fromEmail
}) {
  const normalizedSender = normalizeEmailAddress(fromEmail);
  if (!isAdvisorSender) {
    return normalizedSender;
  }

  const excludedEmails = new Set([
    ...advisorIdentityEmails,
    ...uniqueEmails([inboundAgentEmail, senderEmail])
  ]);

  const rawRecipients = collectRawThreadRecipientAddresses(payload);
  for (const rawRecipient of rawRecipients) {
    const recipientEmail = normalizeEmailAddress(rawRecipient);
    if (!recipientEmail || excludedEmails.has(recipientEmail)) {
      continue;
    }

    return recipientEmail;
  }

  const normalizedRecipients = extractDestinationEmails(payload);
  for (const recipientEmail of normalizedRecipients) {
    if (!recipientEmail || excludedEmails.has(recipientEmail)) {
      continue;
    }

    return recipientEmail;
  }

  return normalizedSender;
}

function hashSenderIdentity(normalizedEmail) {
  return crypto
    .createHash("sha256")
    .update(String(normalizedEmail ?? ""))
    .digest("hex")
    .slice(0, 16);
}

function collectAdvisorMentionedClientEmails({
  payload,
  advisorIdentityEmails,
  advisorSenderEmail,
  inboundAgentEmail
}) {
  const candidates = extractDestinationEmails(payload);
  const exclusions = new Set(advisorIdentityEmails);
  const normalizedAdvisorSender = normalizeEmailAddress(advisorSenderEmail);
  const normalizedInboundAgentEmail = normalizeEmailAddress(inboundAgentEmail);
  if (normalizedAdvisorSender) {
    exclusions.add(normalizedAdvisorSender);
  }
  if (normalizedInboundAgentEmail) {
    exclusions.add(normalizedInboundAgentEmail);
  }

  return candidates.filter((email) => !exclusions.has(email));
}

async function admitClientsFromAdvisorMessage({
  payload,
  advisorId,
  advisorIdentityEmails,
  advisorSenderEmail,
  inboundAgentEmail,
  clientProfilesTableName,
  deps,
  admittedAtIso
}) {
  if (
    !clientProfilesTableName ||
    typeof deps.putClientProfile !== "function" ||
    typeof deps.getClientProfile !== "function"
  ) {
    return [];
  }

  const admittedClientIds = [];
  const admittedEmails = collectAdvisorMentionedClientEmails({
    payload,
    advisorIdentityEmails,
    advisorSenderEmail,
    inboundAgentEmail
  });
  if (admittedEmails.length === 0) {
    return admittedClientIds;
  }

  for (const email of admittedEmails) {
    const clientId = normalizeClientId(email);
    if (!clientId) {
      continue;
    }

    let existing = null;
    try {
      existing = await deps.getClientProfile(clientProfilesTableName, advisorId, clientId);
    } catch {
      existing = null;
    }

    const accessState = normalizeClientAccessState(existing?.accessState, "active");
    const policyId = normalizePolicyId(existing?.policyId) ?? "default";
    const nextProfile = {
      ...(existing ?? {}),
      advisorId,
      clientId,
      clientEmail: email,
      clientDisplayName: existing?.clientDisplayName ?? deriveClientDisplayName(email, email),
      accessState,
      policyId,
      admittedSource: existing?.admittedSource ?? "advisor_email",
      admittedBy: existing?.admittedBy ?? advisorSenderEmail,
      admittedAt: existing?.admittedAt ?? admittedAtIso,
      createdAt: existing?.createdAt ?? admittedAtIso,
      updatedAt: admittedAtIso
    };

    await deps.putClientProfile(clientProfilesTableName, nextProfile);
    admittedClientIds.push(clientId);
  }

  return admittedClientIds;
}

function normalizeAdvisorId(rawValue, fallback = "advisor") {
  const normalized = String(rawValue ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 254);
  if (normalized) {
    return normalized;
  }

  return String(fallback ?? "advisor")
    .trim()
    .toLowerCase()
    .slice(0, 254);
}

function deriveAdvisorIdFromAgentAlias(agentEmail, expectedDomain) {
  const normalizedEmail = normalizeEmailAddress(agentEmail);
  if (!normalizedEmail) {
    return "";
  }

  const [localPart, domainPart] = normalizedEmail.split("@");
  if (!localPart || !domainPart || domainPart !== expectedDomain) {
    return "";
  }

  if (!localPart.endsWith(".agent")) {
    return "";
  }

  const candidate = localPart.slice(0, -".agent".length);
  return normalizeAdvisorId(candidate, "");
}

async function resolveAdvisorContext({ payload, env, deps }) {
  const advisorSettingsTableName = String(env.ADVISOR_SETTINGS_TABLE_NAME ?? "").trim();
  const configuredAgentEmailDomain = String(env.DEFAULT_AGENT_EMAIL_DOMAIN ?? "")
    .trim()
    .toLowerCase();
  const destinationEmails = extractDestinationEmails(payload);
  const inboundAgentEmail =
    destinationEmails.find(
      (email) =>
        configuredAgentEmailDomain &&
        extractDomainFromEmail(email) === configuredAgentEmailDomain
    ) ??
    destinationEmails[0] ??
    "";
  const inboundAgentDomain = extractDomainFromEmail(inboundAgentEmail);
  const shouldRouteByInboundAlias = Boolean(
    inboundAgentEmail && configuredAgentEmailDomain && inboundAgentDomain === configuredAgentEmailDomain
  );

  let advisorId = "unknown";
  let advisorSettings = null;
  let unresolvedReason = "";

  if (shouldRouteByInboundAlias) {
    if (advisorSettingsTableName && typeof deps.getAdvisorSettingsByAgentEmail === "function") {
      try {
        advisorSettings = await deps.getAdvisorSettingsByAgentEmail(
          advisorSettingsTableName,
          inboundAgentEmail
        );
      } catch {
        unresolvedReason = "agent_alias_lookup_failed";
      }

      if (!unresolvedReason) {
        if (advisorSettings?.advisorId) {
          advisorId = normalizeAdvisorId(advisorSettings.advisorId, "advisor");
        } else {
          unresolvedReason = "unknown_agent_alias";
        }
      }
    } else {
      const derivedAdvisorId = deriveAdvisorIdFromAgentAlias(
        inboundAgentEmail,
        configuredAgentEmailDomain
      );
      if (derivedAdvisorId) {
        advisorId = derivedAdvisorId;
      } else {
        unresolvedReason = "agent_alias_routing_unavailable";
      }
    }
  } else if (!inboundAgentEmail) {
    unresolvedReason = "agent_alias_missing";
  } else if (!configuredAgentEmailDomain) {
    unresolvedReason = "agent_alias_routing_unavailable";
  } else {
    unresolvedReason = "agent_alias_invalid_domain";
  }

  if (unresolvedReason) {
    return {
      advisorId: "unknown",
      advisorSettings: null,
      inboundAgentEmail,
      unresolved: true,
      unresolvedReason
    };
  }

  if (!advisorSettings && advisorSettingsTableName && typeof deps.getAdvisorSettings === "function") {
    try {
      advisorSettings = await deps.getAdvisorSettings(advisorSettingsTableName, advisorId);
    } catch {
      advisorSettings = null;
    }
  }

  return {
    advisorId,
    advisorSettings,
    inboundAgentEmail
  };
}

async function parseEmailContentFromMime(rawMime) {
  if (!rawMime) {
    return {
      bodyText: "",
      messageId: "",
      inReplyTo: "",
      references: []
    };
  }

  try {
    const parsed = await simpleParser(rawMime);
    const headers = parsed?.headers;
    const messageIdHeader = typeof headers?.get === "function" ? headers.get("message-id") : "";
    const inReplyToHeader = typeof headers?.get === "function" ? headers.get("in-reply-to") : "";
    const referencesHeader = typeof headers?.get === "function" ? headers.get("references") : "";

    const messageId = normalizeThreadMessageIdValue(parsed?.messageId ?? messageIdHeader);
    const inReplyTo = normalizeThreadMessageIdValue(parsed?.inReplyTo ?? inReplyToHeader);
    const references = normalizeThreadMessageIdList([parsed?.references, referencesHeader]);

    const plainText = String(parsed.text ?? "").trim();
    if (plainText) {
      return {
        bodyText: plainText,
        messageId,
        inReplyTo,
        references
      };
    }

    // Some senders provide HTML-only multipart messages. Fall back to a
    // lightweight HTML-to-text conversion so scheduling intent still parses.
    const html = typeof parsed.html === "string" ? parsed.html : "";
    if (!html) {
      return {
        bodyText: "",
        messageId,
        inReplyTo,
        references
      };
    }

    return {
      bodyText: html
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
        .trim(),
      messageId,
      inReplyTo,
      references
    };
  } catch {
    return {
      bodyText: "",
      messageId: "",
      inReplyTo: "",
      references: []
    };
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
      bodySource: "inline",
      mimeMessageId: "",
      mimeInReplyTo: "",
      mimeReferences: []
    };
  }

  const rawEmailLocation = buildRawEmailLocation(payload, env);
  if (!rawEmailLocation) {
    return {
      bodyText: "",
      bodySource: "none",
      mimeMessageId: "",
      mimeInReplyTo: "",
      mimeReferences: []
    };
  }

  try {
    const rawMime = await deps.getRawEmailObject(rawEmailLocation);
    const parsedMime = await parseEmailContentFromMime(rawMime);
    return {
      bodyText: parsedMime.bodyText,
      bodySource: "mail_store",
      mimeMessageId: parsedMime.messageId,
      mimeInReplyTo: parsedMime.inReplyTo,
      mimeReferences: parsedMime.references
    };
  } catch {
    return {
      bodyText: "",
      bodySource: "mail_store_unavailable",
      mimeMessageId: "",
      mimeInReplyTo: "",
      mimeReferences: []
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
      toEmails: Array.isArray(commonHeaders.to) ? commonHeaders.to : [],
      ccEmails: Array.isArray(commonHeaders.cc) ? commonHeaders.cc : [],
      messageId: commonHeaders.messageId ?? "",
      inReplyTo: commonHeaders.inReplyTo ?? "",
      references: Array.isArray(commonHeaders.references)
        ? commonHeaders.references
        : commonHeaders.references
          ? [commonHeaders.references]
          : [],
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
  const threadReplySubject = buildThreadReplySubject(payload.subject);

  const fromEmail = normalizeEmailAddress(payload.fromEmail);
  if (!fromEmail) {
    return { http: badRequest("fromEmail is required") };
  }
  const clientId = normalizeClientId(fromEmail);
  const clientDisplayName = deriveClientDisplayName(payload.fromEmail, fromEmail);
  const fromDomain = extractDomainFromEmail(fromEmail);
  const {
    bodyText,
    bodySource,
    mimeMessageId,
    mimeInReplyTo,
    mimeReferences
  } = await resolveInboundEmailBody({ payload, env, deps });
  const outboundThreadHeaders = buildOutboundThreadHeaders({
    payload,
    mimeMessageId,
    mimeInReplyTo,
    mimeReferences
  });
  const latestReplyText = extractLatestReplyText(bodyText);
  const quotedThreadContext = extractQuotedThreadContext(bodyText);
  const quotedOnlyReply = !latestReplyText && Boolean(quotedThreadContext);
  const intentInputBodyText = quotedOnlyReply ? "" : latestReplyText || bodyText;
  const intentInputMode = quotedOnlyReply
    ? "quoted_only"
    : latestReplyText && latestReplyText !== bodyText
      ? "latest_reply"
      : "full_body";
  const intentInputLength = intentInputBodyText.length;

  const advisorContext = await resolveAdvisorContext({ payload, env, deps });
  const advisorId = advisorContext.advisorId;
  const advisorSettings = advisorContext.advisorSettings;
  const inboundAgentEmail = advisorContext.inboundAgentEmail;
  if (advisorContext.unresolved) {
    const completedAtMs = now();
    await deps.writeTrace(env.TRACE_TABLE_NAME, {
      requestId,
      responseId,
      advisorId,
      status: "suppressed",
      stage: "advisor_routing",
      errorCode: "UNKNOWN_AGENT_ALIAS_BLACKHOLE",
      providerStatus: "skipped",
      channel: payload.channel ?? "email",
      fromDomain,
      senderHash: hashSenderIdentity(fromEmail),
      admissionDecision: "blackhole",
      admissionReason: advisorContext.unresolvedReason,
      responseMode: (env.RESPONSE_MODE ?? "log").toLowerCase(),
      calendarMode: (env.CALENDAR_MODE ?? "mock").toLowerCase(),
      llmMode: (env.LLM_MODE ?? "disabled").toLowerCase(),
      llmCredentialSource: "not_applicable",
      llmStatus: "skipped_unknown_agent_alias",
      ...buildLlmTraceUsageFields(createLlmUsageAccumulator()),
      bodySource,
      intentSource: "parser",
      intentLlmStatus: "skipped",
      promptGuardMode: normalizePromptGuardMode(env.PROMPT_GUARD_MODE),
      promptGuardDecision: "not_run",
      promptGuardLlmStatus: "not_run",
      promptInjectionRiskLevel: "low",
      promptInjectionSignalCount: 0,
      availabilityLinkStatus: "not_applicable",
      requestedWindowCount: 0,
      ...buildBookingIntentTraceFields({
        bookingIntentSource: "deterministic",
        llmBookingIntent: null,
        llmBookingIntentConfidence: 0
      }),
      ...buildIntentTraceFields({
        intentInputMode,
        intentInputLength,
        intentLlmWindowCount: 0,
        intentLlmRetryUsed: false
      }),
      accessState: "unknown",
      createdAt: startedAtIso,
      updatedAt: new Date(completedAtMs).toISOString(),
      latencyMs: completedAtMs - startedAtMs,
      expiresAt: Math.floor((startedAtMs + 7 * 24 * 60 * 60 * 1000) / 1000)
    });

    return {
      http: ok({
        requestId,
        responseId,
        deliveryStatus: "suppressed",
        llmStatus: "skipped_unknown_agent_alias",
        suggestionCount: 0,
        suggestions: [],
        blackholed: true,
        admissionDecision: "blackhole",
        admissionReason: advisorContext.unresolvedReason
      })
    };
  }

  const hostTimezone = normalizeTimezone(advisorSettings?.timezone, normalizeTimezone(env.HOST_TIMEZONE, DEFAULT_ADVISOR_TIMEZONE));
  const defaultAdvisingDays = parseAdvisingDaysList(env.ADVISING_DAYS ?? "Tue,Wed", ["Tue", "Wed"]);

  const durationDefault = parseIntEnv(env.DEFAULT_DURATION_MINUTES, 30);
  const durationLimit = parseIntEnv(env.MAX_DURATION_MINUTES, 120);
  const searchDays = parseIntEnv(env.SEARCH_DAYS, 14);
  const maxSuggestions = parseIntEnv(env.MAX_SUGGESTIONS, 3);
  const workdayStartHour = parseIntEnv(env.WORKDAY_START_HOUR, 9);
  const workdayEndHour = parseIntEnv(env.WORKDAY_END_HOUR, 17);
  const responseMode = (env.RESPONSE_MODE ?? "log").toLowerCase();
  const calendarMode = (env.CALENDAR_MODE ?? "mock").toLowerCase();
  const configuredAgentEmail = normalizeEmailAddress(advisorSettings?.agentEmail);
  const senderEmail = configuredAgentEmail || normalizeEmailAddress(env.SENDER_EMAIL);
  const threadParticipantEmails = collectThreadParticipantEmails({
    payload,
    fromEmail,
    inboundAgentEmail,
    senderEmail
  });
  const inviteSenderEmail = senderEmail || inboundAgentEmail || "agent@agent.letsconnect.ai";
  const agentDisplayName = deriveAgentDisplayName(
    advisorSettings?.agentName ?? env.AGENT_DISPLAY_NAME,
    {
      configuredAgentEmail,
      senderEmail,
      inboundAgentEmail
    }
  );
  const advisorDisplayName = String(advisorSettings?.preferredName ?? env.ADVISOR_DISPLAY_NAME ?? "").trim();
  const agentReferenceTerms = deriveAgentReferenceTerms({
    agentDisplayName,
    configuredAgentEmail,
    senderEmail,
    inboundAgentEmail
  });
  const advisorInviteEmailOverride = normalizeEmailAddress(advisorSettings?.inviteEmail || env.ADVISOR_INVITE_EMAIL);
  const advisorNotificationEmail = normalizeEmailAddress(
    advisorInviteEmailOverride || advisorSettings?.advisorEmail || env.ADVISOR_EMAIL || senderEmail
  );
  const calendarInviteTitle = String(env.CALENDAR_INVITE_TITLE ?? DEFAULT_CALENDAR_INVITE_TITLE).trim();
  const calendarInviteDescription = String(env.CALENDAR_INVITE_DESCRIPTION ?? "").trim();
  const llmMode = (env.LLM_MODE ?? "disabled").toLowerCase();
  const llmTimeoutMs = parseIntEnv(env.LLM_TIMEOUT_MS, 4000);
  const platformLlmProviderSecretArn = String(env.LLM_PROVIDER_SECRET_ARN ?? "").trim();
  const advisorLlmProviderSecretArn = String(advisorSettings?.llmProviderSecretArn ?? "").trim();
  const advisorLlmKeyMode = String(advisorSettings?.llmKeyMode ?? "")
    .trim()
    .toLowerCase();
  const useAdvisorLlmKey = advisorLlmKeyMode === "advisor" && Boolean(advisorLlmProviderSecretArn);
  const llmProviderSecretArn = useAdvisorLlmKey ? advisorLlmProviderSecretArn : platformLlmProviderSecretArn;
  const llmCredentialSource = useAdvisorLlmKey ? "advisor" : "platform";
  const promptGuardMode = normalizePromptGuardMode(env.PROMPT_GUARD_MODE);
  const promptGuardBlockLevel = normalizePromptGuardLevel(env.PROMPT_GUARD_BLOCK_LEVEL);
  const promptGuardLlmTimeoutMs = parseIntEnv(env.PROMPT_GUARD_LLM_TIMEOUT_MS, DEFAULT_PROMPT_GUARD_LLM_TIMEOUT_MS);
  const intentExtractionMode = (env.INTENT_EXTRACTION_MODE ?? "llm_hybrid").toLowerCase();
  const intentLlmTimeoutMs = parseIntEnv(env.INTENT_LLM_TIMEOUT_MS, 10000);
  const intentConfidenceThreshold = Number.parseFloat(
    env.INTENT_LLM_CONFIDENCE_THRESHOLD ?? String(DEFAULT_INTENT_CONFIDENCE_THRESHOLD)
  );
  const bookingIntentConfidenceThreshold = Number.parseFloat(
    env.BOOKING_INTENT_LLM_CONFIDENCE_THRESHOLD ?? String(DEFAULT_BOOKING_INTENT_CONFIDENCE_THRESHOLD)
  );
  const agentInvocationLlmConfidenceThreshold = Number.parseFloat(
    env.AGENT_INVOCATION_LLM_CONFIDENCE_THRESHOLD ?? String(DEFAULT_AGENT_INVOCATION_LLM_CONFIDENCE_THRESHOLD)
  );
  const inviteSubjectConfidenceThreshold = Number.parseFloat(
    env.INVITE_SUBJECT_LLM_CONFIDENCE_THRESHOLD ?? String(DEFAULT_INVITE_SUBJECT_LLM_CONFIDENCE_THRESHOLD)
  );
  const clientProfilesTableName = String(env.CLIENT_PROFILES_TABLE_NAME ?? "").trim();
  const policyPresetsTableName = String(env.POLICY_PRESETS_TABLE_NAME ?? "").trim();
  const basePolicyPresets = parseClientPolicyPresets(env.CLIENT_POLICY_PRESETS_JSON, defaultAdvisingDays);
  let policyPresets = basePolicyPresets;
  if (policyPresetsTableName && typeof deps.listPolicyPresets === "function") {
    try {
      const customPolicyRecords = await deps.listPolicyPresets(policyPresetsTableName, advisorId);
      policyPresets = mergeClientPolicyPresets(basePolicyPresets, customPolicyRecords);
    } catch {
      policyPresets = basePolicyPresets;
    }
  }
  let promptGuardDecision = "not_run";
  let promptGuardLlmStatus = "disabled";
  let promptInjectionRiskLevel = "low";
  let promptInjectionSignals = [];
  const llmUsageAccumulator = createLlmUsageAccumulator();

  let clientProfile = null;
  const admissionControlEnabled = Boolean(
    clientProfilesTableName && typeof deps.getClientProfile === "function"
  );
  if (clientProfilesTableName && typeof deps.getClientProfile === "function") {
    try {
      clientProfile = await deps.getClientProfile(clientProfilesTableName, advisorId, clientId);
    } catch {
      clientProfile = null;
    }
  }

  const advisorIdentityEmails = collectAdvisorIdentityEmails({
    advisorSettings,
    advisorInviteEmailOverride,
    senderEmail,
    advisorId,
    env
  });
  const isAdvisorSender = advisorIdentityEmails.has(fromEmail);
  const senderDisplayName = deriveClientDisplayName(payload.fromEmail, fromEmail);
  const defaultSuggestionAddresseeDisplayName = resolveSuggestionAddresseeDisplayName({
    payload,
    isAdvisorSender,
    advisorIdentityEmails,
    inboundAgentEmail,
    senderEmail,
    fallbackDisplayName: clientDisplayName
  });
  const defaultSuggestionAddresseeEmail = resolveSuggestionAddresseeEmail({
    payload,
    isAdvisorSender,
    advisorIdentityEmails,
    inboundAgentEmail,
    senderEmail,
    fromEmail
  });
  let suggestionAddresseeDisplayName = defaultSuggestionAddresseeDisplayName;
  let suggestionAddresseeEmail = defaultSuggestionAddresseeEmail || fromEmail;
  const suggestionAddresseeClientId = normalizeClientId(suggestionAddresseeEmail);
  const accessState = isAdvisorSender
    ? "advisor"
    : normalizeClientAccessState(clientProfile?.accessState, admissionControlEnabled ? "unknown" : "active");

  if (admissionControlEnabled && !isAdvisorSender && !clientProfile) {
    const completedAtMs = now();
    await deps.writeTrace(env.TRACE_TABLE_NAME, {
      requestId,
      responseId,
      advisorId,
      status: "suppressed",
      stage: "admission_control",
      errorCode: "UNKNOWN_SENDER_BLACKHOLE",
      providerStatus: "skipped",
      channel: payload.channel ?? "email",
      fromDomain,
      senderHash: hashSenderIdentity(fromEmail),
      admissionDecision: "blackhole",
      admissionReason: "unknown_sender",
      responseMode,
      calendarMode,
      llmMode,
      llmCredentialSource,
      llmStatus: "skipped_unknown_sender",
      ...buildLlmTraceUsageFields(llmUsageAccumulator),
      bodySource,
      intentSource: "parser",
      intentLlmStatus: "skipped",
      promptGuardMode,
      promptGuardDecision,
      promptGuardLlmStatus,
      promptInjectionRiskLevel,
      promptInjectionSignalCount: 0,
      availabilityLinkStatus: "not_applicable",
      requestedWindowCount: 0,
      ...buildBookingIntentTraceFields({
        bookingIntentSource: "deterministic",
        llmBookingIntent: null,
        llmBookingIntentConfidence: 0
      }),
      ...buildIntentTraceFields({
        intentInputMode,
        intentInputLength,
        intentLlmWindowCount: 0,
        intentLlmRetryUsed: false
      }),
      accessState: "unknown",
      createdAt: startedAtIso,
      updatedAt: new Date(completedAtMs).toISOString(),
      latencyMs: completedAtMs - startedAtMs,
      expiresAt: Math.floor((startedAtMs + 7 * 24 * 60 * 60 * 1000) / 1000)
    });

    return {
      http: ok({
        requestId,
        responseId,
        deliveryStatus: "suppressed",
        llmStatus: "skipped_unknown_sender",
        suggestionCount: 0,
        suggestions: [],
        blackholed: true,
        admissionDecision: "blackhole"
      })
    };
  }

  if (isAdvisorSender) {
    try {
      await admitClientsFromAdvisorMessage({
        payload,
        advisorId,
        advisorIdentityEmails,
        advisorSenderEmail: fromEmail,
        inboundAgentEmail,
        clientProfilesTableName,
        deps,
        admittedAtIso: startedAtIso
      });
    } catch {
      // Best-effort admission from advisor-authored thread recipients.
    }
  }

  if (!isAdvisorSender && isClientAccessRestricted(clientProfile)) {
    const deniedMessage = ensurePersonalizedGreetingAndSignature({
      responseMessage: buildAccessDeniedResponseMessage(),
      clientDisplayName,
      agentDisplayName
    });
    let deliveryStatus = "logged";
    if (responseMode === "send" && senderEmail) {
      await sendResponseEmailWithAdvisorCopy({
        deps,
        senderEmail,
        advisorNotificationEmail,
        recipients: [fromEmail],
        subject: threadReplySubject,
        bodyText: deniedMessage.bodyText,
        threadHeaders: outboundThreadHeaders
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
      llmMode,
      llmCredentialSource,
      llmStatus: "disabled",
      ...buildLlmTraceUsageFields(llmUsageAccumulator),
      bodySource,
      intentSource: "parser",
      intentLlmStatus: "disabled",
      promptGuardMode,
      promptGuardDecision,
      promptGuardLlmStatus,
      promptInjectionRiskLevel,
      promptInjectionSignalCount: 0,
      availabilityLinkStatus: "not_applicable",
      requestedWindowCount: 0,
      ...buildBookingIntentTraceFields({
        bookingIntentSource: "deterministic",
        llmBookingIntent: null,
        llmBookingIntentConfidence: 0
      }),
      ...buildIntentTraceFields({
        intentInputMode,
        intentInputLength,
        intentLlmWindowCount: 0,
        intentLlmRetryUsed: false
      }),
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

  if (isCalendarStatusMessage({ subject: payload.subject, bodyText })) {
    const completedAtMs = now();
    await deps.writeTrace(env.TRACE_TABLE_NAME, {
      requestId,
      responseId,
      advisorId,
      status: "suppressed",
      stage: "calendar_status_email",
      errorCode: "CALENDAR_STATUS_MESSAGE_SUPPRESSED",
      providerStatus: "skipped",
      channel: payload.channel ?? "email",
      fromDomain,
      responseMode,
      calendarMode,
      llmMode,
      llmCredentialSource,
      llmStatus: "skipped_calendar_status",
      ...buildLlmTraceUsageFields(llmUsageAccumulator),
      bodySource,
      intentSource: "parser",
      intentLlmStatus: "skipped",
      promptGuardMode,
      promptGuardDecision,
      promptGuardLlmStatus,
      promptInjectionRiskLevel,
      promptInjectionSignalCount: 0,
      availabilityLinkStatus: "not_applicable",
      requestedWindowCount: 0,
      ...buildBookingIntentTraceFields({
        bookingIntentSource: "deterministic",
        llmBookingIntent: null,
        llmBookingIntentConfidence: 0
      }),
      ...buildIntentTraceFields({
        intentInputMode,
        intentInputLength,
        intentLlmWindowCount: 0,
        intentLlmRetryUsed: false
      }),
      accessState,
      createdAt: startedAtIso,
      updatedAt: new Date(completedAtMs).toISOString(),
      latencyMs: completedAtMs - startedAtMs,
      expiresAt: Math.floor((startedAtMs + 7 * 24 * 60 * 60 * 1000) / 1000)
    });

    return {
      http: ok({
        requestId,
        responseId,
        deliveryStatus: "suppressed",
        llmStatus: "skipped_calendar_status",
        suggestionCount: 0,
        suggestions: [],
        suppressed: true,
        suppressionReason: "calendar_status_message"
      })
    };
  }

  const explicitInvocationRequired = threadParticipantEmails.length > 1;
  let invocationSignal = detectExplicitAgentInvocation({
    subject: payload.subject ?? "",
    latestReplyText: latestReplyText || bodyText,
    fullBodyText: bodyText,
    agentReferenceTerms
  });
  let invocationLlmStatus = intentExtractionMode === "llm_hybrid" ? "not_run" : "disabled";
  let invocationLlmValue = null;
  let invocationLlmConfidence = 0;
  let preflightLlmIntent = null;
  let cachedIntentOpenAiConfig = null;
  const llmInvocationHintPresent = hasLlmInvocationHint({
    subject: payload.subject ?? "",
    latestReplyText: latestReplyText || bodyText,
    fullBodyText: bodyText,
    agentReferenceTerms
  });
  const resolvedAgentInvocationLlmConfidenceThreshold = Number.isFinite(agentInvocationLlmConfidenceThreshold)
    ? agentInvocationLlmConfidenceThreshold
    : DEFAULT_AGENT_INVOCATION_LLM_CONFIDENCE_THRESHOLD;
  const resolvedIntentConfidenceThreshold = Number.isFinite(intentConfidenceThreshold)
    ? intentConfidenceThreshold
    : DEFAULT_INTENT_CONFIDENCE_THRESHOLD;
  const resolvedBookingIntentConfidenceThreshold = Number.isFinite(bookingIntentConfidenceThreshold)
    ? bookingIntentConfidenceThreshold
    : DEFAULT_BOOKING_INTENT_CONFIDENCE_THRESHOLD;

  if (invocationSignal.invoked && !isAdvisorSender) {
    suggestionAddresseeDisplayName = senderDisplayName || suggestionAddresseeDisplayName;
    suggestionAddresseeEmail = fromEmail;
  }

  if (
    explicitInvocationRequired &&
    llmInvocationHintPresent &&
    intentExtractionMode === "llm_hybrid" &&
    llmProviderSecretArn &&
    typeof deps.extractSchedulingIntentWithLlm === "function"
  ) {
    try {
      const llmSecretString = await deps.getSecretString(llmProviderSecretArn);
      const openAiConfig = parseOpenAiConfigSecret(llmSecretString);
      cachedIntentOpenAiConfig = openAiConfig;
      const invocationInputBody = intentInputMode === "latest_reply" && quotedThreadContext
        ? buildThreadAwareIntentBody({
          latestReplyText: intentInputBodyText,
          quotedThreadContext
        })
        : intentInputBodyText;
      const llmInvocationIntent = await deps.extractSchedulingIntentWithLlm({
        openAiConfig,
        subject: payload.subject ?? "",
        body: invocationInputBody,
        agentDisplayName,
        agentIdentityHints: agentReferenceTerms,
        hostTimezone,
        referenceNowIso: startedAtIso,
        fetchImpl: deps.fetchImpl,
        timeoutMs: intentLlmTimeoutMs,
        retryPolicy: "invocation_check"
      });
      accumulateLlmTelemetry(llmUsageAccumulator, llmInvocationIntent?.llmTelemetry);
      preflightLlmIntent = llmInvocationIntent;
      invocationLlmStatus = "ok";
      invocationLlmValue = typeof llmInvocationIntent?.invocationIntent === "boolean"
        ? llmInvocationIntent.invocationIntent
        : null;
      invocationLlmConfidence = Number.isFinite(Number(llmInvocationIntent?.invocationIntentConfidence))
        ? Number(llmInvocationIntent.invocationIntentConfidence)
        : 0;
      const llmWindowCount = Array.isArray(llmInvocationIntent?.requestedWindows)
        ? llmInvocationIntent.requestedWindows.length
        : 0;
      const llmWindowConfidence = Number.isFinite(Number(llmInvocationIntent?.confidence))
        ? Number(llmInvocationIntent.confidence)
        : 0;
      const llmBookingValue = typeof llmInvocationIntent?.bookingIntent === "boolean"
        ? llmInvocationIntent.bookingIntent
        : null;
      const llmBookingConfidence = Number.isFinite(Number(llmInvocationIntent?.bookingIntentConfidence))
        ? Number(llmInvocationIntent.bookingIntentConfidence)
        : 0;
      const llmSignalsInvocation =
        invocationLlmValue === true &&
        invocationLlmConfidence >= resolvedAgentInvocationLlmConfidenceThreshold;
      const llmSignalsSchedulingIntent =
        llmBookingValue === true &&
        llmBookingConfidence >= resolvedBookingIntentConfidenceThreshold;
      const llmSignalsTimeframeIntent =
        llmWindowCount > 0 &&
        llmWindowConfidence >= resolvedIntentConfidenceThreshold;
      if (llmSignalsInvocation || llmSignalsSchedulingIntent || llmSignalsTimeframeIntent) {
        invocationSignal = {
          invoked: true,
          matchedTerm: "",
          matchedLine: "llm_invocation_classifier",
          source: "llm"
        };
        if (!isAdvisorSender) {
          suggestionAddresseeDisplayName = senderDisplayName || suggestionAddresseeDisplayName;
          suggestionAddresseeEmail = fromEmail;
        }
      }
    } catch {
      invocationLlmStatus = "fallback";
    }
  }

  if (explicitInvocationRequired && !invocationSignal.invoked) {
    const completedAtMs = now();
    await deps.writeTrace(env.TRACE_TABLE_NAME, {
      requestId,
      responseId,
      advisorId,
      status: "suppressed",
      stage: "agent_invocation",
      errorCode: "AGENT_NOT_INVOKED",
      providerStatus: "skipped",
      channel: payload.channel ?? "email",
      fromDomain,
      responseMode,
      calendarMode,
      llmMode,
      llmCredentialSource,
      llmStatus: "skipped_not_invoked",
      ...buildLlmTraceUsageFields(llmUsageAccumulator),
      bodySource,
      intentSource: "parser",
      intentLlmStatus: invocationLlmStatus === "ok" ? "ok" : "skipped",
      promptGuardMode,
      promptGuardDecision,
      promptGuardLlmStatus,
      promptInjectionRiskLevel,
      promptInjectionSignalCount: 0,
      availabilityLinkStatus: "not_applicable",
      requestedWindowCount: 0,
      agentInvocationRequired: true,
      agentInvocationDetected: false,
      agentInvocationSource: invocationSignal.source,
      agentInvocationLlmStatus: invocationLlmStatus,
      agentInvocationLlmValue:
        invocationLlmValue === null ? "unknown" : invocationLlmValue ? "true" : "false",
      agentInvocationLlmConfidence: invocationLlmConfidence,
      ...buildBookingIntentTraceFields({
        bookingIntentSource: "deterministic",
        llmBookingIntent: null,
        llmBookingIntentConfidence: 0
      }),
      ...buildIntentTraceFields({
        intentInputMode,
        intentInputLength,
        intentLlmWindowCount: 0,
        intentLlmRetryUsed: false
      }),
      accessState,
      createdAt: startedAtIso,
      updatedAt: new Date(completedAtMs).toISOString(),
      latencyMs: completedAtMs - startedAtMs,
      expiresAt: Math.floor((startedAtMs + 7 * 24 * 60 * 60 * 1000) / 1000)
    });

    return {
      http: ok({
        requestId,
        responseId,
        deliveryStatus: "suppressed",
        llmStatus: "skipped_not_invoked",
        suggestionCount: 0,
        suggestions: [],
        suppressed: true,
        suppressionReason: "agent_not_invoked"
      })
    };
  }

  if (promptGuardMode !== "off") {
    const heuristicAssessment = assessPromptInjectionRisk({
      subject: payload.subject ?? "",
      body: bodyText
    });
    promptInjectionRiskLevel = heuristicAssessment.riskLevel;
    const heuristicSignals = heuristicAssessment.matchedSignals ?? [];
    let llmRiskLevel = "low";
    let llmSignals = [];
    const shouldUsePromptGuardLlm = promptGuardMode === "llm" || promptGuardMode === "heuristic_llm";

    if (shouldUsePromptGuardLlm) {
      if (!llmProviderSecretArn || typeof deps.analyzePromptInjectionRiskWithLlm !== "function") {
        promptGuardLlmStatus = "skipped";
      } else {
        try {
          const llmSecretString = await deps.getSecretString(llmProviderSecretArn);
          const openAiConfig = parseOpenAiConfigSecret(llmSecretString);
          const llmAssessment = await deps.analyzePromptInjectionRiskWithLlm({
            openAiConfig,
            subject: payload.subject ?? "",
            body: bodyText,
            fetchImpl: deps.fetchImpl,
            timeoutMs: promptGuardLlmTimeoutMs
          });
          accumulateLlmTelemetry(llmUsageAccumulator, llmAssessment?.llmTelemetry);
          promptGuardLlmStatus = "ok";
          llmRiskLevel = normalizePromptGuardLevel(llmAssessment.riskLevel, "medium");
          llmSignals = Array.isArray(llmAssessment.signals) ? llmAssessment.signals : [];
        } catch {
          promptGuardLlmStatus = "fallback";
        }
      }
    }

    promptInjectionSignals = mergePromptGuardSignals({
      heuristicSignals,
      llmSignals
    });

    if (PROMPT_GUARD_LEVEL_RANK[llmRiskLevel] > PROMPT_GUARD_LEVEL_RANK[promptInjectionRiskLevel]) {
      promptInjectionRiskLevel = llmRiskLevel;
    }

    if (PROMPT_GUARD_LEVEL_RANK[promptInjectionRiskLevel] >= PROMPT_GUARD_LEVEL_RANK[promptGuardBlockLevel]) {
      promptGuardDecision = "fallback";
      let responseMessage = buildPromptGuardFallbackResponseMessage();
      let availabilityLinkStatus = "pending";
      try {
        const availabilityLinkResult = await buildAvailabilityLink({
          env,
          deps,
          advisorId,
          hostTimezone,
          clientTimezone: null,
          durationMinutes: durationDefault,
          issuedAtMs: startedAtMs,
          firstSuggestedSlotStartIsoUtc: null,
          normalizedClientEmail: suggestionAddresseeEmail,
          clientDisplayName: suggestionAddresseeDisplayName,
          clientId: suggestionAddresseeClientId
        });
        availabilityLinkStatus = availabilityLinkResult.status;
        responseMessage = appendAvailabilityLinkSection({
          responseMessage,
          availabilityLink: availabilityLinkResult.availabilityLink
        });
      } catch {
        availabilityLinkStatus = "error";
      }

      responseMessage = ensurePersonalizedGreetingAndSignature({
        responseMessage,
        clientDisplayName,
        agentDisplayName
      });

      let deliveryStatus = "logged";
      if (responseMode === "send") {
        if (!senderEmail) {
          return { http: badRequest("SENDER_EMAIL (or advisor agentEmail setting) is required when RESPONSE_MODE=send") };
        }

        await sendResponseEmailWithAdvisorCopy({
          deps,
          senderEmail,
          advisorNotificationEmail,
          recipients: [fromEmail],
          subject: threadReplySubject,
          bodyText: responseMessage.bodyText,
          threadHeaders: outboundThreadHeaders
        });
        deliveryStatus = "sent";
      }

      const completedAtMs = now();
      await deps.writeTrace(env.TRACE_TABLE_NAME, {
        requestId,
        responseId,
        advisorId,
        accessState,
        status: "guarded",
        stage: "prompt_guard",
        providerStatus: "skipped",
        channel: payload.channel ?? "email",
        fromDomain,
        responseMode,
        calendarMode,
        llmMode,
        llmCredentialSource,
        llmStatus: "guarded",
        ...buildLlmTraceUsageFields(llmUsageAccumulator),
        bodySource,
        intentSource: "parser",
        intentLlmStatus: "skipped_guarded",
        promptGuardMode,
        promptGuardDecision,
        promptGuardLlmStatus,
        promptInjectionRiskLevel,
        promptInjectionSignalCount: promptInjectionSignals.length,
        availabilityLinkStatus,
        requestedWindowCount: 0,
        ...buildBookingIntentTraceFields({
          bookingIntentSource: "deterministic",
          llmBookingIntent: null,
          llmBookingIntentConfidence: 0
        }),
        ...buildIntentTraceFields({
          intentInputMode,
          intentInputLength,
          intentLlmWindowCount: 0,
          intentLlmRetryUsed: false
        }),
        createdAt: startedAtIso,
        updatedAt: new Date(completedAtMs).toISOString(),
        latencyMs: completedAtMs - startedAtMs,
        expiresAt: Math.floor((startedAtMs + 7 * 24 * 60 * 60 * 1000) / 1000)
      });

      if (!isAdvisorSender && clientProfilesTableName && typeof deps.recordClientEmailInteraction === "function") {
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
          llmStatus: "guarded",
          suggestionCount: 0,
          suggestions: [],
          promptGuarded: true,
          promptInjectionRiskLevel
        })
      };
    }
  } else {
    promptGuardDecision = "allow";
    promptGuardLlmStatus = "disabled";
    promptInjectionRiskLevel = "low";
    promptInjectionSignals = [];
  }

  if (promptGuardDecision !== "fallback") {
    promptGuardDecision = "allow";
  }

  const advisingDays = resolveClientAdvisingDays({
    clientProfile,
    defaultAdvisingDays,
    policyPresets
  });

  let parserIntent = parseSchedulingRequest({
    fromEmail,
    subject: payload.subject ?? "",
    body: intentInputBodyText,
    defaultDurationMinutes: durationDefault,
    fallbackTimezone: hostTimezone,
    referenceIso: startedAtIso
  });

  if (intentInputMode === "latest_reply" && quotedThreadContext) {
    const threadAwareParserIntent = parseSchedulingRequest({
      fromEmail,
      subject: payload.subject ?? "",
      body: buildThreadAwareParserBody({
        latestReplyText: intentInputBodyText,
        quotedThreadContext
      }),
      defaultDurationMinutes: durationDefault,
      fallbackTimezone: hostTimezone,
      referenceIso: startedAtIso
    });

    const parserWindows = Array.isArray(parserIntent?.requestedWindows) ? parserIntent.requestedWindows : [];
    const threadWindows = Array.isArray(threadAwareParserIntent?.requestedWindows)
      ? threadAwareParserIntent.requestedWindows
      : [];
    const shouldAdoptThreadWindows = parserWindows.length === 0 && threadWindows.length > 0;
    const parserDuration = Number.parseInt(parserIntent?.durationMinutes ?? durationDefault, 10);
    const threadDuration = Number.parseInt(threadAwareParserIntent?.durationMinutes ?? durationDefault, 10);
    const shouldAdoptThreadDuration = parserDuration === durationDefault && threadDuration !== durationDefault;
    const shouldAdoptThreadTimezone =
      !parserIntent?.clientTimezone && Boolean(threadAwareParserIntent?.clientTimezone);

    if (shouldAdoptThreadWindows || shouldAdoptThreadDuration || shouldAdoptThreadTimezone) {
      parserIntent = {
        ...parserIntent,
        requestedWindows: shouldAdoptThreadWindows ? threadWindows : parserWindows,
        durationMinutes: shouldAdoptThreadDuration ? threadDuration : parserDuration,
        clientTimezone: shouldAdoptThreadTimezone ? threadAwareParserIntent.clientTimezone : parserIntent.clientTimezone
      };
    }
  }

  let parsed = parserIntent;
  let intentSource = "parser";
  let intentLlmStatus = "disabled";
  let intentLlmWindowCount = 0;
  let intentLlmRetryUsed = false;
  let llmBookingIntent = null;
  let llmBookingIntentConfidence = 0;
  let bookingIntentSource = "deterministic";

  if (intentExtractionMode === "llm_hybrid") {
    try {
      if (!llmProviderSecretArn) {
        throw new Error("LLM_PROVIDER_SECRET_ARN is required for INTENT_EXTRACTION_MODE=llm_hybrid");
      }

      let openAiConfig = cachedIntentOpenAiConfig;
      if (!openAiConfig) {
        const llmSecretString = await deps.getSecretString(llmProviderSecretArn);
        openAiConfig = parseOpenAiConfigSecret(llmSecretString);
        cachedIntentOpenAiConfig = openAiConfig;
      }
      const reusedPreflightIntent = Boolean(preflightLlmIntent);
      const llmIntent = preflightLlmIntent ?? (await deps.extractSchedulingIntentWithLlm({
        openAiConfig,
        subject: payload.subject ?? "",
        body: intentInputBodyText,
        agentDisplayName,
        agentIdentityHints: agentReferenceTerms,
        hostTimezone,
        referenceNowIso: startedAtIso,
        fetchImpl: deps.fetchImpl,
        timeoutMs: intentLlmTimeoutMs
      }));
      if (!reusedPreflightIntent) {
        accumulateLlmTelemetry(llmUsageAccumulator, llmIntent?.llmTelemetry);
      }
      preflightLlmIntent = null;
      let mergedLlmIntent = llmIntent;
      const resolvedBookingIntentConfidenceThreshold = Number.isFinite(bookingIntentConfidenceThreshold)
        ? bookingIntentConfidenceThreshold
        : DEFAULT_BOOKING_INTENT_CONFIDENCE_THRESHOLD;
      const parserRequestedWindowCount = Array.isArray(parserIntent.requestedWindows)
        ? parserIntent.requestedWindows.length
        : 0;
      const llmRequestedWindowCount = Array.isArray(mergedLlmIntent?.requestedWindows)
        ? mergedLlmIntent.requestedWindows.length
        : 0;
      const llmHasBookingDecision = typeof mergedLlmIntent?.bookingIntent === "boolean";
      const llmBookingConfidence = Number.isFinite(Number(mergedLlmIntent?.bookingIntentConfidence))
        ? Number(mergedLlmIntent.bookingIntentConfidence)
        : 0;
      const parserLooksBroad = parserRequestedWindowCount >= 7;
      const needsBookingDisambiguation =
        !llmHasBookingDecision || llmBookingConfidence < resolvedBookingIntentConfidenceThreshold;
      const shouldRetryThreadContext =
        intentInputMode === "latest_reply" &&
        Boolean(quotedThreadContext) &&
        ((parserRequestedWindowCount === 0 && llmRequestedWindowCount === 0) ||
          (parserLooksBroad && needsBookingDisambiguation));
      if (shouldRetryThreadContext) {
        try {
          const threadAwareLlmIntent = await deps.extractSchedulingIntentWithLlm({
            openAiConfig,
            subject: payload.subject ?? "",
            body: buildThreadAwareIntentBody({
              latestReplyText: intentInputBodyText,
              quotedThreadContext
            }),
            agentDisplayName,
            agentIdentityHints: agentReferenceTerms,
            hostTimezone,
            referenceNowIso: startedAtIso,
            fetchImpl: deps.fetchImpl,
            timeoutMs: intentLlmTimeoutMs,
            retryPolicy: "thread_context"
          });
          accumulateLlmTelemetry(llmUsageAccumulator, threadAwareLlmIntent?.llmTelemetry);
          intentLlmRetryUsed = true;
          const threadRequestedWindowCount = Array.isArray(threadAwareLlmIntent?.requestedWindows)
            ? threadAwareLlmIntent.requestedWindows.length
            : 0;
          const threadHasBookingDecision = typeof threadAwareLlmIntent?.bookingIntent === "boolean";
          const threadBookingConfidence = Number.isFinite(Number(threadAwareLlmIntent?.bookingIntentConfidence))
            ? Number(threadAwareLlmIntent.bookingIntentConfidence)
            : 0;
          const shouldAdoptThreadWindows =
            threadRequestedWindowCount > 0 &&
            (llmRequestedWindowCount === 0 || parserLooksBroad || threadRequestedWindowCount < llmRequestedWindowCount);
          const shouldAdoptThreadBookingIntent =
            threadHasBookingDecision &&
            (!llmHasBookingDecision ||
              threadBookingConfidence > llmBookingConfidence ||
              (threadBookingConfidence >= resolvedBookingIntentConfidenceThreshold &&
                llmBookingConfidence < resolvedBookingIntentConfidenceThreshold));
          if (shouldAdoptThreadWindows || shouldAdoptThreadBookingIntent) {
            mergedLlmIntent = {
              ...mergedLlmIntent,
              requestedWindows: shouldAdoptThreadWindows
                ? threadAwareLlmIntent.requestedWindows
                : mergedLlmIntent?.requestedWindows,
              clientTimezone: threadAwareLlmIntent?.clientTimezone ?? mergedLlmIntent?.clientTimezone ?? null,
              confidence: Number.isFinite(Number(threadAwareLlmIntent?.confidence))
                ? Number(threadAwareLlmIntent.confidence)
                : mergedLlmIntent?.confidence,
              bookingIntent: shouldAdoptThreadBookingIntent
                ? threadAwareLlmIntent.bookingIntent
                : mergedLlmIntent?.bookingIntent,
              bookingIntentConfidence: shouldAdoptThreadBookingIntent
                ? threadBookingConfidence
                : llmBookingConfidence
            };
          }
        } catch {
          intentLlmRetryUsed = true;
        }
      }

      const shouldRetryBroadWindow =
        Array.isArray(parserIntent.requestedWindows) &&
        parserIntent.requestedWindows.length === 0 &&
        Array.isArray(mergedLlmIntent?.requestedWindows) &&
        mergedLlmIntent.requestedWindows.length === 0;
      if (shouldRetryBroadWindow) {
        try {
          const retriedLlmIntent = await deps.extractSchedulingIntentWithLlm({
            openAiConfig,
            subject: payload.subject ?? "",
            body: intentInputBodyText,
            agentDisplayName,
            agentIdentityHints: agentReferenceTerms,
            hostTimezone,
            referenceNowIso: startedAtIso,
            fetchImpl: deps.fetchImpl,
            timeoutMs: intentLlmTimeoutMs,
            retryPolicy: "broad_windows"
          });
          accumulateLlmTelemetry(llmUsageAccumulator, retriedLlmIntent?.llmTelemetry);
          intentLlmRetryUsed = true;
          if (Array.isArray(retriedLlmIntent?.requestedWindows) && retriedLlmIntent.requestedWindows.length > 0) {
            mergedLlmIntent = retriedLlmIntent;
          }
        } catch {
          intentLlmRetryUsed = true;
        }
      }
      intentLlmWindowCount = Array.isArray(mergedLlmIntent?.requestedWindows) ? mergedLlmIntent.requestedWindows.length : 0;
      llmBookingIntent = typeof mergedLlmIntent?.bookingIntent === "boolean" ? mergedLlmIntent.bookingIntent : null;
      llmBookingIntentConfidence = Number.isFinite(Number(mergedLlmIntent?.bookingIntentConfidence))
        ? Number(mergedLlmIntent.bookingIntentConfidence)
        : 0;
      if (typeof mergedLlmIntent?.invocationIntent === "boolean") {
        invocationLlmValue = mergedLlmIntent.invocationIntent;
        invocationLlmConfidence = Number.isFinite(Number(mergedLlmIntent?.invocationIntentConfidence))
          ? Number(mergedLlmIntent.invocationIntentConfidence)
          : invocationLlmConfidence;
        if (invocationLlmStatus === "not_run") {
          invocationLlmStatus = "ok";
        }
      }

      const merged = mergeParsedIntent({
        parserIntent,
        llmIntent: mergedLlmIntent,
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
      intentLlmWindowCount = 0;
      llmBookingIntent = null;
      llmBookingIntentConfidence = 0;
    }
  }

  const requestedDaypart = detectRequestedDaypart(payload.subject ?? "", intentInputBodyText);
  if (requestedDaypart && parsed.requestedWindows.length > 0) {
    const constrainedWindows = constrainRequestedWindowsToDaypart({
      requestedWindows: parsed.requestedWindows,
      daypart: requestedDaypart,
      timezone: parsed.clientTimezone ?? hostTimezone
    });
    if (constrainedWindows.length > 0) {
      parsed = {
        ...parsed,
        requestedWindows: constrainedWindows
      };
    }
  }

  if (parsed.durationMinutes > durationLimit) {
    return { http: badRequest(`duration exceeds limit (${durationLimit} minutes)`) };
  }

  const searchStartIso = new Date(startedAtMs).toISOString();
  const searchEndIso = new Date(startedAtMs + searchDays * 24 * 60 * 60 * 1000).toISOString();

  let busyIntervals = [];
  let providerStatus = "ok";
  let activeConnection = null;
  let connectedConnections = [];

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
    } else if (calendarMode === "microsoft") {
      const secretArn = env.MICROSOFT_OAUTH_SECRET_ARN;
      if (!secretArn) {
        throw new Error("MICROSOFT_OAUTH_SECRET_ARN is required for CALENDAR_MODE=microsoft");
      }

      const secretString = await deps.getSecretString(secretArn);
      const oauthConfig = parseMicrosoftOauthSecret(secretString);
      busyIntervals = await deps.lookupMicrosoftBusyIntervals({
        oauthConfig,
        windowStartIso: searchStartIso,
        windowEndIso: searchEndIso,
        fetchImpl: deps.fetchImpl
      });
    } else if (calendarMode === "connection") {
      const connectionsTableName = env.CONNECTIONS_TABLE_NAME;
      connectedConnections = await listConnectedCalendarConnections({
        deps,
        connectionsTableName,
        advisorId
      });
      if (connectedConnections.length === 0) {
        throw new Error("No connected calendars found. Add a calendar in Advisor Portal.");
      }

      activeConnection = selectPrimaryConnectionCandidate(connectedConnections);
      const mergedBusyIntervals = [];

      for (const connection of connectedConnections) {
        if (connection.provider === "mock") {
          continue;
        }

        if (connection.provider === "google") {
          if (!connection.secretArn) {
            throw new Error("Google connection is missing secretArn");
          }

          const secretString = await deps.getSecretString(connection.secretArn);
          const oauthConfig = parseGoogleOauthSecret(secretString);
          const providerBusyIntervals = await deps.lookupBusyIntervals({
            oauthConfig,
            windowStartIso: searchStartIso,
            windowEndIso: searchEndIso,
            fetchImpl: deps.fetchImpl
          });
          mergedBusyIntervals.push(...providerBusyIntervals);
          continue;
        }

        if (connection.provider === "microsoft") {
          if (!connection.secretArn) {
            throw new Error("Microsoft connection is missing secretArn");
          }

          const secretString = await deps.getSecretString(connection.secretArn);
          const oauthConfig = parseMicrosoftOauthSecret(secretString);
          const providerBusyIntervals = await deps.lookupMicrosoftBusyIntervals({
            oauthConfig,
            windowStartIso: searchStartIso,
            windowEndIso: searchEndIso,
            fetchImpl: deps.fetchImpl
          });
          mergedBusyIntervals.push(...providerBusyIntervals);
          continue;
        }

        throw new Error(`Unsupported provider for CALENDAR_MODE=connection: ${connection.provider}`);
      }

      busyIntervals = mergedBusyIntervals.sort((left, right) => Date.parse(left.startIso) - Date.parse(right.startIso));
    } else {
      throw new Error(`Unsupported CALENDAR_MODE value: ${calendarMode}`);
    }
  } catch (error) {
    const errorMessage = String(error?.message ?? "");
    const isConnectionRequired =
      error?.code === "CALENDAR_CONNECTION_REQUIRED" ||
      errorMessage.includes("No connected calendars found");
    if (isConnectionRequired) {
      let deliveryStatus = "logged";
      let advisorNotificationStatus = "not_sent";
      let clientHoldStatus = "not_sent";

      if (responseMode === "send") {
        if (!senderEmail) {
          return { http: badRequest("SENDER_EMAIL (or advisor agentEmail setting) is required when RESPONSE_MODE=send") };
        }

        if (advisorNotificationEmail) {
          const advisorMessage = buildCalendarConnectionRequiredAdvisorMessage({
            originalSubject: payload.subject,
            clientEmail: fromEmail,
            bodyText,
            startedAtIso
          });
          await deps.sendResponseEmail({
            senderEmail,
            recipientEmail: advisorNotificationEmail,
            subject: threadReplySubject,
            bodyText: advisorMessage.bodyText,
            threadHeaders: outboundThreadHeaders
          });
          advisorNotificationStatus = "sent";
        } else {
          advisorNotificationStatus = "missing_destination";
        }

        const clientHoldMessage = ensurePersonalizedGreetingAndSignature({
          responseMessage: buildCalendarConnectionRequiredClientHoldMessage(payload.subject),
          clientDisplayName,
          agentDisplayName
        });
        await sendResponseEmailWithAdvisorCopy({
          deps,
          senderEmail,
          advisorNotificationEmail,
          recipients: [fromEmail],
          subject: threadReplySubject,
          bodyText: clientHoldMessage.bodyText,
          threadHeaders: outboundThreadHeaders
        });
        clientHoldStatus = "sent";
        deliveryStatus = "sent";
      }

      const completedAtMs = now();
      await deps.writeTrace(env.TRACE_TABLE_NAME, {
        requestId,
        responseId,
        advisorId,
        accessState,
        status: "deferred",
        stage: "calendar_connection_required",
        providerStatus: "unavailable",
        errorCode: "CALENDAR_CONNECTION_REQUIRED",
        responseMode,
        calendarMode,
        llmMode,
        llmCredentialSource,
        llmStatus: "skipped_no_calendar",
        ...buildLlmTraceUsageFields(llmUsageAccumulator),
        bodySource,
        intentSource,
        intentLlmStatus,
        promptGuardMode,
        promptGuardDecision,
        promptGuardLlmStatus,
        promptInjectionRiskLevel,
        promptInjectionSignalCount: promptInjectionSignals.length,
        bookingStatus: "calendar_connection_required",
        advisorNotificationStatus,
        clientHoldStatus,
        availabilityLinkStatus: "not_applicable",
        requestedWindowCount: parsed.requestedWindows.length,
        ...buildBookingIntentTraceFields({
          bookingIntentSource,
          llmBookingIntent,
          llmBookingIntentConfidence
        }),
        ...buildIntentTraceFields({
          intentInputMode,
          intentInputLength,
          intentLlmWindowCount,
          intentLlmRetryUsed
        }),
        createdAt: startedAtIso,
        updatedAt: new Date(completedAtMs).toISOString(),
        latencyMs: completedAtMs - startedAtMs,
        fromDomain,
        expiresAt: Math.floor((startedAtMs + 7 * 24 * 60 * 60 * 1000) / 1000)
      });

      if (!isAdvisorSender && clientProfilesTableName && typeof deps.recordClientEmailInteraction === "function") {
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
          llmStatus: "skipped_no_calendar",
          bookingStatus: "calendar_connection_required",
          suggestionCount: 0,
          suggestions: [],
          calendarConnectionRequired: true,
          advisorNotificationStatus,
          clientHoldStatus
        })
      };
    }

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
      ...buildLlmTraceUsageFields(llmUsageAccumulator),
      intentSource,
      intentLlmStatus,
      promptGuardMode,
      promptGuardDecision,
      promptGuardLlmStatus,
      promptInjectionRiskLevel,
      promptInjectionSignalCount: promptInjectionSignals.length,
      requestedWindowCount: parsed.requestedWindows.length,
      ...buildBookingIntentTraceFields({
        bookingIntentSource,
        llmBookingIntent,
        llmBookingIntentConfidence
      }),
      ...buildIntentTraceFields({
        intentInputMode,
        intentInputLength,
        intentLlmWindowCount,
        intentLlmRetryUsed
      }),
      createdAt: startedAtIso,
      updatedAt: new Date(now()).toISOString(),
      fromDomain,
      expiresAt: Math.floor((startedAtMs + 7 * 24 * 60 * 60 * 1000) / 1000)
    });

    return {
      http: serverError(requestId, `calendar lookup failed: ${error.message}`)
    };
  }

  const normalizedRequestedWindows = normalizeRequestedWindowsToUtc(parsed.requestedWindows);
  const suggestions = generateCandidateSlots({
    busyIntervalsUtc: busyIntervals,
    requestedWindowsUtc: normalizedRequestedWindows,
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
  let availabilityLinkStatus = "pending";
  let bookingStatus = "not_requested";
  let bookingConfirmationStatus = "not_applicable";
  let inviteMeetingUrl = "";
  let meetingLinkProvider = normalizeMeetingLinkProvider(
    advisorSettings?.meetingProvider ?? env.MEETING_LINK_PROVIDER,
    DEFAULT_MEETING_LINK_PROVIDER
  );
  let meetingLinkStatus = "not_applicable";
  let meetingLinkErrorCode = "not_applicable";
  let meetingLinkErrorMessage = "";
  let inviteRecipients = [];
  let inviteSubjectSource = "not_applicable";
  let inviteSubjectConfidence = 0;
  const bookingCandidateSpecific = hasSpecificBookingCandidate({
    normalizedRequestedWindows,
    durationMinutes: parsed.durationMinutes
  });
  const deterministicBookingRequested = hasBookingIntent({
    subject: payload.subject,
    body: intentInputBodyText,
    normalizedRequestedWindows,
    agentReferenceTerms
  }) && bookingCandidateSpecific;
  const hasHighConfidenceLlmBookingIntent =
    typeof llmBookingIntent === "boolean" &&
    Number.isFinite(bookingIntentConfidenceThreshold) &&
    llmBookingIntentConfidence >= bookingIntentConfidenceThreshold;
  let bookingRequested = deterministicBookingRequested;
  if (intentExtractionMode === "llm_hybrid" && intentLlmStatus === "ok") {
    if (hasHighConfidenceLlmBookingIntent) {
      bookingRequested = bookingCandidateSpecific ? llmBookingIntent : false;
      bookingIntentSource = "llm";
    } else {
      bookingRequested = deterministicBookingRequested;
      bookingIntentSource = "deterministic_fallback";
    }
  }

  if (bookingRequested) {
    if (suggestions.length > 0) {
      const advisorInviteEmail = normalizeEmailAddress(
        advisorInviteEmailOverride || activeConnection?.accountEmail || env.ADVISOR_EMAIL || senderEmail
      );
      const advisorInviteDisplayName =
        normalizeInviteParticipantName(advisorDisplayName) ||
        normalizeInviteParticipantName(deriveDisplayNameFromEmail(advisorNotificationEmail)) ||
        "Advisor";
      const nonAdvisorParticipantName = isAdvisorSender ? defaultSuggestionAddresseeDisplayName : senderDisplayName;
      const fallbackInviteSubject = buildFallbackInviteSubject({
        clientDisplayName: nonAdvisorParticipantName,
        advisorDisplayName: advisorInviteDisplayName
      });
      let inviteSubject = fallbackInviteSubject;
      inviteSubjectSource = "deterministic_fallback";
      inviteSubjectConfidence = 0;

      if (llmMode === "openai" && llmProviderSecretArn && typeof deps.suggestInviteSubjectWithLlm === "function") {
        try {
          const llmSecretString = await deps.getSecretString(llmProviderSecretArn);
          const openAiConfig = parseOpenAiConfigSecret(llmSecretString);
          const inviteSubjectSuggestion = await deps.suggestInviteSubjectWithLlm({
            openAiConfig,
            threadSubject: payload.subject ?? "",
            latestReplyText: intentInputBodyText,
            quotedThreadContext,
            advisorDisplayName: advisorInviteDisplayName,
            clientDisplayName: nonAdvisorParticipantName,
            agentDisplayName,
            fetchImpl: deps.fetchImpl,
            timeoutMs: llmTimeoutMs
          });
          accumulateLlmTelemetry(llmUsageAccumulator, inviteSubjectSuggestion?.llmTelemetry);
          if (
            inviteSubjectSuggestion?.subject &&
            Number.isFinite(Number(inviteSubjectSuggestion?.confidence)) &&
            Number(inviteSubjectSuggestion.confidence) >=
              (Number.isFinite(inviteSubjectConfidenceThreshold)
                ? inviteSubjectConfidenceThreshold
                : DEFAULT_INVITE_SUBJECT_LLM_CONFIDENCE_THRESHOLD)
          ) {
            inviteSubject = inviteSubjectSuggestion.subject;
            inviteSubjectSource = "llm";
            inviteSubjectConfidence = Number(inviteSubjectSuggestion.confidence);
          } else if (inviteSubjectSuggestion?.subject) {
            inviteSubjectSource = "llm_low_confidence_fallback";
            inviteSubjectConfidence = Number.isFinite(Number(inviteSubjectSuggestion?.confidence))
              ? Number(inviteSubjectSuggestion.confidence)
              : 0;
          }
        } catch {
          inviteSubjectSource = "llm_error_fallback";
          inviteSubjectConfidence = 0;
        }
      }

      const meetingLinkResolution = await resolveMeetingLinkForInvite({
        env,
        deps,
        advisorSettings,
        selectedSlotStartIsoUtc: suggestions[0].startIsoUtc,
        durationMinutes: parsed.durationMinutes,
        hostTimezone,
        inviteSubject,
        calendarMode,
        activeConnection,
        connectedConnections
      });
      inviteMeetingUrl = String(meetingLinkResolution.meetingUrl ?? "").trim();
      meetingLinkProvider = meetingLinkResolution.provider;
      meetingLinkStatus = meetingLinkResolution.status;
      meetingLinkErrorCode = String(meetingLinkResolution.errorCode ?? "").trim() || "none";
      meetingLinkErrorMessage = String(meetingLinkResolution.errorMessage ?? "").trim();

      inviteRecipients = uniqueEmails([
        ...(threadParticipantEmails.length > 0 ? threadParticipantEmails : [fromEmail]),
        advisorInviteEmail
      ]);
      responseMessage = buildCalendarInviteMessage({
        subject: inviteSubject,
        selectedSlot: suggestions[0],
        hostTimezone,
        clientTimezone: parsed.clientTimezone,
        meetingUrl: inviteMeetingUrl,
        agentDisplayName,
        senderEmail: inviteSenderEmail,
        attendeeEmails: inviteRecipients,
        requestId,
        nowIso: startedAtIso,
        inviteTitle: calendarInviteTitle,
        inviteDescription: calendarInviteDescription
      });
      llmStatus = "skipped_booking";
      availabilityLinkStatus = "not_applicable";
      bookingStatus = "invite_ready";
    } else {
      bookingStatus = "slot_unavailable";
      llmStatus = "skipped_booking";
      inviteSubjectSource = "not_applicable";
      inviteSubjectConfidence = 0;
      responseMessage = {
        subject: `Re: ${payload.subject || "Meeting request"}`,
        bodyText:
          "I could not lock the requested slot because it appears unavailable.\nPlease share another time window and I will send alternatives."
      };
      try {
        const availabilityLinkResult = await buildAvailabilityLink({
          env,
          deps,
          advisorId,
          hostTimezone,
          clientTimezone: parsed.clientTimezone,
          durationMinutes: parsed.durationMinutes,
          issuedAtMs: startedAtMs,
          firstSuggestedSlotStartIsoUtc: suggestions[0]?.startIsoUtc,
          normalizedClientEmail: suggestionAddresseeEmail,
          clientDisplayName: suggestionAddresseeDisplayName,
          clientId: suggestionAddresseeClientId
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
  }

  if (bookingStatus === "not_requested") {
    if (llmMode === "openai") {
      try {
        if (!llmProviderSecretArn) {
          throw new Error("LLM_PROVIDER_SECRET_ARN is required for LLM_MODE=openai");
        }

        const llmSecretString = await deps.getSecretString(llmProviderSecretArn);
        const openAiConfig = parseOpenAiConfigSecret(llmSecretString);
        const llmDraft = await deps.draftResponseWithLlm({
          openAiConfig,
          suggestions,
          hostTimezone,
          clientTimezone: parsed.clientTimezone,
          originalSubject: payload.subject,
          advisorDisplayName,
          agentDisplayName,
          fetchImpl: deps.fetchImpl,
          timeoutMs: llmTimeoutMs
        });
        accumulateLlmTelemetry(llmUsageAccumulator, llmDraft?.llmTelemetry);
        responseMessage = {
          subject: llmDraft.subject,
          bodyText: llmDraft.bodyText
        };
        llmStatus = "ok";
      } catch {
        llmStatus = "fallback";
        responseMessage = templateResponseMessage;
      }
    } else if (llmMode !== "disabled") {
      llmStatus = "unsupported";
    }

    try {
      const availabilityLinkResult = await buildAvailabilityLink({
        env,
        deps,
        advisorId,
        hostTimezone,
        clientTimezone: parsed.clientTimezone,
        durationMinutes: parsed.durationMinutes,
        issuedAtMs: startedAtMs,
        firstSuggestedSlotStartIsoUtc: suggestions[0]?.startIsoUtc,
        normalizedClientEmail: suggestionAddresseeEmail,
        clientDisplayName: suggestionAddresseeDisplayName,
        clientId: suggestionAddresseeClientId
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

  if (bookingStatus !== "invite_ready") {
    responseMessage = {
      ...responseMessage,
      subject: threadReplySubject
    };
  }

  responseMessage = ensurePersonalizedGreetingAndSignature({
    responseMessage,
    clientDisplayName: suggestionAddresseeDisplayName,
    agentDisplayName
  });

  let deliveryStatus = "logged";

  if (responseMode === "send") {
    if (!senderEmail) {
      return { http: badRequest("SENDER_EMAIL (or advisor agentEmail setting) is required when RESPONSE_MODE=send") };
    }

    if (bookingStatus === "invite_ready") {
      const bookingConfirmationMessage = ensurePersonalizedGreetingAndSignature({
        responseMessage: buildBookingConfirmationMessage({
          subject: threadReplySubject,
          selectedSlot: suggestions[0],
          hostTimezone,
          clientTimezone: parsed.clientTimezone,
          meetingUrl: inviteMeetingUrl
        }),
        clientDisplayName: suggestionAddresseeDisplayName,
        agentDisplayName
      });
      const responseRecipients = uniqueEmails(
        threadParticipantEmails.length > 0 ? threadParticipantEmails : [fromEmail]
      );
      if (typeof deps.sendResponseEmail === "function") {
        try {
          await sendResponseEmailWithAdvisorCopy({
            deps,
            senderEmail,
            advisorNotificationEmail,
            recipients: responseRecipients,
            subject: bookingConfirmationMessage.subject,
            bodyText: bookingConfirmationMessage.bodyText,
            threadHeaders: outboundThreadHeaders
          });
          bookingConfirmationStatus = "sent";
        } catch {
          bookingConfirmationStatus = "failed";
        }
      } else {
        bookingConfirmationStatus = "skipped";
      }

      if (typeof deps.sendCalendarInviteEmail === "function") {
        await deps.sendCalendarInviteEmail({
          senderEmail,
          toEmails: inviteRecipients.length > 0 ? inviteRecipients : [fromEmail],
          subject: responseMessage.subject,
          bodyText: responseMessage.bodyText,
          icsContent: responseMessage.icsContent,
          threadHeaders: outboundThreadHeaders
        });
      } else {
        const fallbackRecipients = inviteRecipients.length > 0 ? inviteRecipients : [fromEmail];
        await sendResponseEmailWithAdvisorCopy({
          deps,
          senderEmail,
          advisorNotificationEmail,
          recipients: fallbackRecipients,
          subject: responseMessage.subject,
          bodyText: responseMessage.bodyText,
          threadHeaders: outboundThreadHeaders
        });
      }
      bookingStatus = "invite_sent";
    } else {
      const responseRecipients = uniqueEmails(
        threadParticipantEmails.length > 0 ? threadParticipantEmails : [fromEmail]
      );
      await sendResponseEmailWithAdvisorCopy({
        deps,
        senderEmail,
        advisorNotificationEmail,
        recipients: responseRecipients,
        subject: responseMessage.subject,
        bodyText: responseMessage.bodyText,
        threadHeaders: outboundThreadHeaders
      });
    }

    deliveryStatus = "sent";
  } else if (bookingStatus === "invite_ready") {
    bookingConfirmationStatus = "logged";
    bookingStatus = "invite_logged";
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
    llmCredentialSource,
    llmStatus,
    ...buildLlmTraceUsageFields(llmUsageAccumulator),
    bodySource,
    intentSource,
    intentLlmStatus,
    promptGuardMode,
    promptGuardDecision,
    promptGuardLlmStatus,
    promptInjectionRiskLevel,
    promptInjectionSignalCount: promptInjectionSignals.length,
    bookingStatus,
    bookingConfirmationStatus,
    meetingLinkProvider,
    meetingLinkStatus,
    meetingLinkErrorCode,
    meetingLinkErrorMessage,
    inviteSubjectSource,
    inviteSubjectConfidence,
    inviteRecipientCount: inviteRecipients.length,
    availabilityLinkStatus,
    requestedWindowCount: parsed.requestedWindows.length,
    agentInvocationRequired: explicitInvocationRequired,
    agentInvocationDetected: invocationSignal.invoked,
    agentInvocationSource: invocationSignal.source,
    agentInvocationLlmStatus: invocationLlmStatus,
    agentInvocationLlmValue:
      invocationLlmValue === null ? "unknown" : invocationLlmValue ? "true" : "false",
    agentInvocationLlmConfidence: invocationLlmConfidence,
    ...buildBookingIntentTraceFields({
      bookingIntentSource,
      llmBookingIntent,
      llmBookingIntentConfidence
    }),
    ...buildIntentTraceFields({
      intentInputMode,
      intentInputLength,
      intentLlmWindowCount,
      intentLlmRetryUsed
    }),
    createdAt: startedAtIso,
    updatedAt: new Date(completedAtMs).toISOString(),
    latencyMs: completedAtMs - startedAtMs,
    expiresAt: Math.floor((startedAtMs + 7 * 24 * 60 * 60 * 1000) / 1000)
  });

  if (!isAdvisorSender && clientProfilesTableName && typeof deps.recordClientEmailInteraction === "function") {
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
      bookingStatus,
      bookingConfirmationStatus,
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
    lookupMicrosoftBusyIntervals,
    draftResponseWithLlm: draftResponseWithOpenAi,
    extractSchedulingIntentWithLlm: extractSchedulingIntentWithOpenAi,
    analyzePromptInjectionRiskWithLlm: analyzePromptInjectionRiskWithOpenAi,
    suggestInviteSubjectWithLlm: suggestInviteSubjectWithOpenAi,
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
