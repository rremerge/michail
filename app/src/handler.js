import crypto from "node:crypto";
import { DateTime } from "luxon";
import { parseSchedulingRequest } from "./intent-parser.js";
import { generateCandidateSlots } from "./slot-generator.js";
import { parseGoogleOauthSecret, lookupGoogleBusyIntervals } from "./google-adapter.js";
import {
  analyzePromptInjectionRiskWithOpenAi,
  assessPromptInjectionRisk,
  draftResponseWithOpenAi,
  extractSchedulingIntentWithOpenAi,
  parseOpenAiConfigSecret
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
const DEFAULT_AVAILABILITY_LINK_TTL_MINUTES = 7 * 24 * 60;
const DEFAULT_ADVISOR_TIMEZONE = "America/Los_Angeles";
const DEFAULT_PROMPT_GUARD_MODE = "heuristic_llm";
const DEFAULT_PROMPT_GUARD_BLOCK_LEVEL = "high";
const DEFAULT_PROMPT_GUARD_LLM_TIMEOUT_MS = 3000;
const DEFAULT_CALENDAR_INVITE_TITLE = "Advisory Meeting";
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
const BOOKING_INTENT_KEYWORDS =
  /\b(book|confirm|lock|reserve|schedule|send (?:me )?(?:the )?invite|calendar invite|works for me|that works|go ahead)\b/i;
const PROMPT_GUARD_ALLOWED_MODES = new Set(["off", "heuristic", "llm", "heuristic_llm"]);

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

function hasBookingIntent({ subject, body, normalizedRequestedWindows }) {
  if (!Array.isArray(normalizedRequestedWindows) || normalizedRequestedWindows.length === 0) {
    return false;
  }

  const merged = `${String(subject ?? "")}\n${String(body ?? "")}`;
  return BOOKING_INTENT_KEYWORDS.test(merged);
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
  organizerEmail,
  organizerName,
  attendeeEmails
}) {
  const dtStamp = formatDateUtcForIcs(nowIso);
  const dtStart = formatDateUtcForIcs(startIsoUtc);
  const dtEnd = formatDateUtcForIcs(endIsoUtc);
  const normalizedSummary = escapeIcsText(summary);
  const normalizedDescription = escapeIcsText(description);
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

function buildCalendarInviteMessage({
  subject,
  selectedSlot,
  hostTimezone,
  clientTimezone,
  advisorDisplayName,
  senderEmail,
  attendeeEmails,
  requestId,
  nowIso,
  inviteTitle,
  inviteDescription
}) {
  const hostLabel = formatInviteLabel(selectedSlot.startIsoUtc, hostTimezone);
  const clientLabel = clientTimezone ? formatInviteLabel(selectedSlot.startIsoUtc, clientTimezone) : null;
  const safeTitle = String(inviteTitle ?? DEFAULT_CALENDAR_INVITE_TITLE).trim() || DEFAULT_CALENDAR_INVITE_TITLE;
  const safeDescription =
    String(inviteDescription ?? "").trim() ||
    `Scheduled via LetsConnect.ai. Advisor timezone: ${hostTimezone}.`;
  const meetingUid = `${requestId}@letsconnect.ai`;

  const bodyLines = [
    `I have prepared a calendar invite for ${hostLabel}.`,
    clientLabel ? `Your local time: ${clientLabel}.` : null,
    "Please accept the invite in your calendar app."
  ].filter(Boolean);

  const icsContent = buildIcsInvite({
    uid: meetingUid,
    nowIso,
    startIsoUtc: selectedSlot.startIsoUtc,
    endIsoUtc: selectedSlot.endIsoUtc,
    summary: safeTitle,
    description: safeDescription,
    organizerEmail: senderEmail,
    organizerName: advisorDisplayName,
    attendeeEmails
  });

  return {
    subject: `Calendar invite: ${subject || "Meeting request"}`,
    bodyText: bodyLines.join("\n"),
    icsContent
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

  const values = [];
  for (const token of raw.split(",")) {
    const normalized = normalizeEmailAddress(token);
    if (normalized) {
      values.push(normalized);
    }
  }

  return values;
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

  if (Array.isArray(payload?.ses?.receipt?.recipients)) {
    for (const value of payload.ses.receipt.recipients) {
      pushEmail(value);
    }
  }

  return [...new Set(candidates)];
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

async function resolveAdvisorContext({ payload, env, deps }) {
  const fallbackAdvisorId = normalizeAdvisorId(env.ADVISOR_ID ?? "manoj", "manoj");
  const advisorSettingsTableName = String(env.ADVISOR_SETTINGS_TABLE_NAME ?? "").trim();
  const destinationEmails = extractDestinationEmails(payload);
  const inboundAgentEmail = destinationEmails[0] ?? "";

  let advisorId = fallbackAdvisorId;
  let advisorSettings = null;

  if (
    inboundAgentEmail &&
    advisorSettingsTableName &&
    typeof deps.getAdvisorSettingsByAgentEmail === "function"
  ) {
    try {
      advisorSettings = await deps.getAdvisorSettingsByAgentEmail(
        advisorSettingsTableName,
        inboundAgentEmail
      );
      if (advisorSettings?.advisorId) {
        advisorId = normalizeAdvisorId(advisorSettings.advisorId, fallbackAdvisorId);
      }
    } catch {
      advisorSettings = null;
    }
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
      toEmails: Array.isArray(commonHeaders.to) ? commonHeaders.to : [],
      ccEmails: Array.isArray(commonHeaders.cc) ? commonHeaders.cc : [],
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

  const advisorContext = await resolveAdvisorContext({ payload, env, deps });
  const advisorId = advisorContext.advisorId;
  const advisorSettings = advisorContext.advisorSettings;
  const inboundAgentEmail = advisorContext.inboundAgentEmail;

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
  const senderEmail =
    normalizeEmailAddress(advisorSettings?.agentEmail) || normalizeEmailAddress(env.SENDER_EMAIL);
  const inviteSenderEmail = senderEmail || inboundAgentEmail || "agent@agent.letsconnect.ai";
  const advisorDisplayName = deriveAdvisorDisplayName(
    String(advisorSettings?.preferredName ?? "").trim() || env.ADVISOR_DISPLAY_NAME,
    advisorId
  );
  const advisorInviteEmailOverride = normalizeEmailAddress(advisorSettings?.inviteEmail || env.ADVISOR_INVITE_EMAIL);
  const advisorNotificationEmail = normalizeEmailAddress(
    advisorInviteEmailOverride || advisorSettings?.advisorEmail || env.ADVISOR_EMAIL || senderEmail
  );
  const calendarInviteTitle = String(env.CALENDAR_INVITE_TITLE ?? DEFAULT_CALENDAR_INVITE_TITLE).trim();
  const calendarInviteDescription = String(env.CALENDAR_INVITE_DESCRIPTION ?? "").trim();
  const llmMode = (env.LLM_MODE ?? "disabled").toLowerCase();
  const llmTimeoutMs = parseIntEnv(env.LLM_TIMEOUT_MS, 4000);
  const llmProviderSecretArn = env.LLM_PROVIDER_SECRET_ARN ?? "";
  const promptGuardMode = normalizePromptGuardMode(env.PROMPT_GUARD_MODE);
  const promptGuardBlockLevel = normalizePromptGuardLevel(env.PROMPT_GUARD_BLOCK_LEVEL);
  const promptGuardLlmTimeoutMs = parseIntEnv(env.PROMPT_GUARD_LLM_TIMEOUT_MS, DEFAULT_PROMPT_GUARD_LLM_TIMEOUT_MS);
  const intentExtractionMode = (env.INTENT_EXTRACTION_MODE ?? "llm_hybrid").toLowerCase();
  const intentLlmTimeoutMs = parseIntEnv(env.INTENT_LLM_TIMEOUT_MS, 10000);
  const intentConfidenceThreshold = Number.parseFloat(
    env.INTENT_LLM_CONFIDENCE_THRESHOLD ?? String(DEFAULT_INTENT_CONFIDENCE_THRESHOLD)
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
      llmStatus: "skipped_unknown_sender",
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
      advisorDisplayName
    });
    let deliveryStatus = "logged";
    if (responseMode === "send" && senderEmail) {
      await deps.sendResponseEmail({
        senderEmail,
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
      promptGuardMode,
      promptGuardDecision,
      promptGuardLlmStatus,
      promptInjectionRiskLevel,
      promptInjectionSignalCount: 0,
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
          clientTimezone: null,
          durationMinutes: durationDefault,
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

      responseMessage = ensurePersonalizedGreetingAndSignature({
        responseMessage,
        clientDisplayName,
        advisorDisplayName
      });

      let deliveryStatus = "logged";
      if (responseMode === "send") {
        if (!senderEmail) {
          return { http: badRequest("SENDER_EMAIL (or advisor agentEmail setting) is required when RESPONSE_MODE=send") };
        }

        await deps.sendResponseEmail({
          senderEmail,
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
        status: "guarded",
        stage: "prompt_guard",
        providerStatus: "skipped",
        channel: payload.channel ?? "email",
        fromDomain,
        responseMode,
        calendarMode,
        llmMode,
        llmStatus: "guarded",
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

  const requestedDaypart = detectRequestedDaypart(payload.subject ?? "", bodyText);
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
      activeConnection = connection;

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
            subject: advisorMessage.subject,
            bodyText: advisorMessage.bodyText
          });
          advisorNotificationStatus = "sent";
        } else {
          advisorNotificationStatus = "missing_destination";
        }

        const clientHoldMessage = ensurePersonalizedGreetingAndSignature({
          responseMessage: buildCalendarConnectionRequiredClientHoldMessage(payload.subject),
          clientDisplayName,
          advisorDisplayName
        });
        await deps.sendResponseEmail({
          senderEmail,
          recipientEmail: fromEmail,
          subject: clientHoldMessage.subject,
          bodyText: clientHoldMessage.bodyText
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
        llmStatus: "skipped_no_calendar",
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
      intentSource,
      intentLlmStatus,
      promptGuardMode,
      promptGuardDecision,
      promptGuardLlmStatus,
      promptInjectionRiskLevel,
      promptInjectionSignalCount: promptInjectionSignals.length,
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
  let inviteRecipients = [];

  const bookingRequested = hasBookingIntent({
    subject: payload.subject,
    body: bodyText,
    normalizedRequestedWindows
  });

  if (bookingRequested) {
    if (suggestions.length > 0) {
      const advisorInviteEmail = normalizeEmailAddress(
        advisorInviteEmailOverride || activeConnection?.accountEmail || env.ADVISOR_EMAIL || senderEmail
      );
      inviteRecipients = uniqueEmails([fromEmail, advisorInviteEmail]);
      responseMessage = buildCalendarInviteMessage({
        subject: payload.subject,
        selectedSlot: suggestions[0],
        hostTimezone,
        clientTimezone: parsed.clientTimezone,
        advisorDisplayName,
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
  }

  if (bookingStatus === "not_requested") {
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
    if (!senderEmail) {
      return { http: badRequest("SENDER_EMAIL (or advisor agentEmail setting) is required when RESPONSE_MODE=send") };
    }

    if (bookingStatus === "invite_ready") {
      if (typeof deps.sendCalendarInviteEmail === "function") {
        await deps.sendCalendarInviteEmail({
          senderEmail,
          toEmails: inviteRecipients.length > 0 ? inviteRecipients : [fromEmail],
          subject: responseMessage.subject,
          bodyText: responseMessage.bodyText,
          icsContent: responseMessage.icsContent
        });
      } else {
        const fallbackRecipients = inviteRecipients.length > 0 ? inviteRecipients : [fromEmail];
        for (const recipientEmail of fallbackRecipients) {
          await deps.sendResponseEmail({
            senderEmail,
            recipientEmail,
            subject: responseMessage.subject,
            bodyText: responseMessage.bodyText
          });
        }
      }
      bookingStatus = "invite_sent";
    } else {
      await deps.sendResponseEmail({
        senderEmail,
        recipientEmail: fromEmail,
        subject: responseMessage.subject,
        bodyText: responseMessage.bodyText
      });
    }

    deliveryStatus = "sent";
  } else if (bookingStatus === "invite_ready") {
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
    llmStatus,
    bodySource,
    intentSource,
    intentLlmStatus,
    promptGuardMode,
    promptGuardDecision,
    promptGuardLlmStatus,
    promptInjectionRiskLevel,
    promptInjectionSignalCount: promptInjectionSignals.length,
    bookingStatus,
    inviteRecipientCount: inviteRecipients.length,
    availabilityLinkStatus,
    requestedWindowCount: parsed.requestedWindows.length,
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
    analyzePromptInjectionRiskWithLlm: analyzePromptInjectionRiskWithOpenAi,
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
