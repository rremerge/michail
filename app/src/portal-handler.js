import crypto from "node:crypto";
import { createRuntimeDeps } from "./runtime-deps.js";
import { DateTime, Interval } from "luxon";
import { parseGoogleOauthSecret, lookupGoogleBusyIntervals, lookupGoogleClientMeetings } from "./google-adapter.js";
import { parseAvailabilityLinkSecret, validateAvailabilityLinkToken } from "./availability-link.js";
import {
  isClientAccessRestricted,
  mergeClientPolicyPresets,
  normalizeClientAccessState,
  normalizeClientId,
  normalizePolicyId,
  normalizePolicyPresetRecord,
  parseAdvisingDaysList,
  parseClientPolicyPresets,
  resolveClientAdvisingDays
} from "./client-profile.js";

function parseIntEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseClampedIntEnv(value, fallback, minimum, maximum) {
  const parsed = parseIntEnv(value, fallback);
  return Math.min(Math.max(parsed, minimum), maximum);
}

const AVAILABILITY_VIEW_DAYS = 7;

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

function parseAdvisingDays(value) {
  return parseAdvisingDaysList(value ?? "Tue,Wed", ["Tue", "Wed"]);
}

function parseWeekOffset(queryStringParameters) {
  const rawValue = String(queryStringParameters?.weekOffset ?? "0").trim();
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed)) {
    return 0;
  }

  return Math.min(Math.max(parsed, -8), 52);
}

function decodeClientHint(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  return raw
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

function sanitizeClientDisplayName(value) {
  const candidate = String(value ?? "").trim();
  if (!candidate) {
    return null;
  }

  return candidate.replace(/\s+/g, " ").slice(0, 64);
}

function normalizeClientReference(value) {
  const candidate = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);
  return candidate || null;
}

function parseBody(event) {
  if (!event.body) {
    return {};
  }

  const bodyText = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  return typeof bodyText === "string" ? JSON.parse(bodyText) : bodyText;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function htmlResponse(statusCode, html) {
  return {
    statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    },
    body: html
  };
}

function redirectResponse(location, headers = {}) {
  return {
    statusCode: 302,
    headers: {
      location,
      "cache-control": "no-store",
      ...headers
    },
    body: ""
  };
}

function routeNotFound() {
  return jsonResponse(404, { error: "Not found" });
}

function badRequest(message) {
  return jsonResponse(400, { error: message });
}

function serverError(message) {
  return jsonResponse(500, { error: message });
}

function unauthorized() {
  return {
    statusCode: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": 'Basic realm="Advisor Portal", charset="UTF-8"'
    },
    body: "Unauthorized"
  };
}

function parseGoogleAppSecret(secretString) {
  const parsed = JSON.parse(secretString);
  const clientId = parsed.client_id;
  const clientSecret = parsed.client_secret;

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth app secret is missing client_id or client_secret");
  }

  return { clientId, clientSecret };
}

function parsePortalAuthSecret(secretString) {
  const parsed = JSON.parse(secretString);
  const username = String(parsed.username ?? "").trim();
  const password = String(parsed.password ?? "");

  if (!username || !password) {
    throw new Error("Advisor portal auth secret is missing username or password");
  }

  return { username, password };
}

function parsePortalSessionSecret(secretString) {
  const parsed = JSON.parse(secretString);
  const signingKey = String(parsed.signing_key ?? "").trim();
  if (!signingKey) {
    throw new Error("Advisor portal session secret is missing signing_key");
  }

  return { signingKey };
}

function getBaseUrl(event) {
  const domainName = event.requestContext?.domainName;
  const stage = event.requestContext?.stage;

  if (!domainName) {
    throw new Error("Missing requestContext.domainName");
  }

  if (!stage || stage === "$default") {
    return `https://${domainName}`;
  }

  return `https://${domainName}/${stage}`;
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

function shouldProtectPath(rawPath) {
  if (!rawPath.startsWith("/advisor")) {
    return false;
  }

  return ![
    "/advisor/auth/google/start",
    "/advisor/auth/google/callback",
    "/advisor/api/connections/google/callback"
  ].includes(rawPath);
}

function parseBasicAuthorizationHeader(headers) {
  const authorizationHeader = headers?.authorization ?? headers?.Authorization;
  if (!authorizationHeader || !authorizationHeader.startsWith("Basic ")) {
    return null;
  }

  const encoded = authorizationHeader.slice("Basic ".length).trim();
  if (!encoded) {
    return null;
  }

  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex < 0) {
    return null;
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1)
  };
}

function constantTimeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

const portalAuthSecretCache = {
  secretArn: null,
  credentials: null
};

const portalSessionSecretCache = {
  secretArn: null,
  secretValue: null
};

async function getPortalAuthCredentials(deps, secretArn) {
  if (portalAuthSecretCache.secretArn === secretArn && portalAuthSecretCache.credentials) {
    return portalAuthSecretCache.credentials;
  }

  const secretString = await deps.getSecretString(secretArn);
  const credentials = parsePortalAuthSecret(secretString);
  portalAuthSecretCache.secretArn = secretArn;
  portalAuthSecretCache.credentials = credentials;
  return credentials;
}

async function getPortalSessionSecret(deps, secretArn) {
  if (portalSessionSecretCache.secretArn === secretArn && portalSessionSecretCache.secretValue) {
    return portalSessionSecretCache.secretValue;
  }

  const secretString = await deps.getSecretString(secretArn);
  const secretValue = parsePortalSessionSecret(secretString);
  portalSessionSecretCache.secretArn = secretArn;
  portalSessionSecretCache.secretValue = secretValue;
  return secretValue;
}

function encodeBase64Url(input) {
  return Buffer.from(input, "utf8").toString("base64url");
}

function decodeBase64Url(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function createPortalSessionToken(payload, signingKey) {
  const payloadEncoded = encodeBase64Url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", signingKey).update(payloadEncoded).digest("base64url");
  return `${payloadEncoded}.${signature}`;
}

function validatePortalSessionToken(token, signingKey, nowMs = Date.now()) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const splitIndex = token.lastIndexOf(".");
  if (splitIndex <= 0) {
    return null;
  }

  const payloadEncoded = token.slice(0, splitIndex);
  const suppliedSignature = token.slice(splitIndex + 1);
  const expectedSignature = crypto.createHmac("sha256", signingKey).update(payloadEncoded).digest("base64url");
  if (!constantTimeEquals(suppliedSignature, expectedSignature)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(payloadEncoded));
  } catch {
    return null;
  }

  if (typeof payload.expiresAtMs !== "number" || payload.expiresAtMs <= nowMs) {
    return null;
  }

  return payload;
}

function parseCookies(event) {
  if (Array.isArray(event?.cookies) && event.cookies.length > 0) {
    return event.cookies.reduce((accumulator, pair) => {
      const separator = pair.indexOf("=");
      if (separator < 0) {
        return accumulator;
      }

      const key = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      accumulator[key] = value;
      return accumulator;
    }, {});
  }

  const cookieHeader = event?.headers?.cookie ?? event?.headers?.Cookie;
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((accumulator, pair) => {
      const separator = pair.indexOf("=");
      if (separator < 0) {
        return accumulator;
      }

      const key = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      accumulator[key] = value;
      return accumulator;
    }, {});
}

function isApiRoute(rawPath) {
  return rawPath.startsWith("/advisor/api/");
}

function buildPathWithQuery(event, normalizedRawPath) {
  const query = event.rawQueryString;
  if (!query) {
    return normalizedRawPath;
  }

  return `${normalizedRawPath}?${query}`;
}

async function authorizePortalRequest({ event, rawPath, deps }) {
  if (!shouldProtectPath(rawPath)) {
    return null;
  }

  const authMode = (process.env.ADVISOR_PORTAL_AUTH_MODE ?? "none").toLowerCase();
  if (authMode === "none") {
    return null;
  }

  if (authMode === "secret_basic") {
    const authSecretArn = process.env.ADVISOR_PORTAL_AUTH_SECRET_ARN;
    if (!authSecretArn) {
      return serverError("ADVISOR_PORTAL_AUTH_SECRET_ARN is required when auth mode is secret_basic");
    }

    let expectedCredentials;
    try {
      expectedCredentials = await getPortalAuthCredentials(deps, authSecretArn);
    } catch (error) {
      return serverError(error.message);
    }

    const suppliedCredentials = parseBasicAuthorizationHeader(event.headers);
    if (!suppliedCredentials) {
      return unauthorized();
    }

    const usernameMatches = constantTimeEquals(suppliedCredentials.username, expectedCredentials.username);
    const passwordMatches = constantTimeEquals(suppliedCredentials.password, expectedCredentials.password);
    if (!usernameMatches || !passwordMatches) {
      return unauthorized();
    }

    return null;
  }

  if (authMode === "google_oauth") {
    const sessionSecretArn = process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN;
    if (!sessionSecretArn) {
      return serverError("ADVISOR_PORTAL_SESSION_SECRET_ARN is required when auth mode is google_oauth");
    }

    let sessionSecret;
    try {
      sessionSecret = await getPortalSessionSecret(deps, sessionSecretArn);
    } catch (error) {
      return serverError(error.message);
    }

    const cookies = parseCookies(event);
    const sessionToken = cookies.advisor_portal_session;
    const sessionPayload = validatePortalSessionToken(sessionToken, sessionSecret.signingKey);
    if (sessionPayload?.email) {
      return null;
    }

    if (isApiRoute(rawPath)) {
      return jsonResponse(401, { error: "Unauthorized" });
    }

    const returnTo = encodeURIComponent(buildPathWithQuery(event, rawPath));
    return redirectResponse(`${getBaseUrl(event)}/advisor/auth/google/start?returnTo=${returnTo}`);
  }

  return serverError(`Unsupported ADVISOR_PORTAL_AUTH_MODE value: ${authMode}`);
}

function buildSessionCookie(sessionToken, maxAgeSeconds) {
  return [
    `advisor_portal_session=${sessionToken}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

function buildClearSessionCookie() {
  return [
    "advisor_portal_session=",
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

function isAuthorizedAdvisorEmail(profileEmail) {
  const normalizedEmail = String(profileEmail ?? "").trim().toLowerCase();
  if (!normalizedEmail) {
    return false;
  }

  const allowedEmail = String(process.env.ADVISOR_ALLOWED_EMAIL ?? "").trim().toLowerCase();
  if (!allowedEmail) {
    return true;
  }

  return normalizedEmail === allowedEmail;
}

function parseReturnTo(queryStringParameters) {
  const candidate = queryStringParameters?.returnTo;
  if (!candidate || typeof candidate !== "string") {
    return "/advisor";
  }

  if (!candidate.startsWith("/advisor")) {
    return "/advisor";
  }

  return candidate;
}

function escapeHtml(rawValue) {
  return String(rawValue ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeWeekdays(weekdays) {
  const accepted = new Set();
  for (const weekday of weekdays) {
    accepted.add(String(weekday ?? "").slice(0, 3).toLowerCase());
  }

  return accepted;
}

function normalizeAdvisorResponseStatus(rawStatus) {
  const normalized = String(rawStatus ?? "")
    .trim()
    .toLowerCase();
  return normalized === "accepted" ? "accepted" : "pending";
}

function normalizeMeetingDisplayTitle(value) {
  const title = String(value ?? "").trim();
  return title.length > 0 ? title : "Client meeting";
}

function clipRangeToSlot(startMs, endMs, slotStartMs, slotEndMs) {
  const clippedStart = Math.max(startMs, slotStartMs);
  const clippedEnd = Math.min(endMs, slotEndMs);
  if (clippedEnd <= clippedStart) {
    return null;
  }

  return [clippedStart, clippedEnd];
}

function hasBusyOutsideClientMeetings({
  slotStartMs,
  slotEndMs,
  busyIntervals,
  clientMeetings,
  nonClientBusyIntervals
}) {
  const clippedBusy = [];
  const clippedClient = [];
  const clippedNonClientBusy = [];

  for (const busyInterval of busyIntervals) {
    const clipped = clipRangeToSlot(busyInterval.startMs, busyInterval.endMs, slotStartMs, slotEndMs);
    if (clipped) {
      clippedBusy.push(clipped);
    }
  }

  for (const meeting of clientMeetings) {
    const clipped = clipRangeToSlot(meeting.startMs, meeting.endMs, slotStartMs, slotEndMs);
    if (clipped) {
      clippedClient.push(clipped);
    }
  }

  for (const busyInterval of nonClientBusyIntervals) {
    const clipped = clipRangeToSlot(busyInterval.startMs, busyInterval.endMs, slotStartMs, slotEndMs);
    if (clipped) {
      clippedNonClientBusy.push(clipped);
    }
  }

  if (clippedNonClientBusy.length > 0) {
    return true;
  }

  if (clippedBusy.length === 0) {
    return false;
  }

  const points = new Set([slotStartMs, slotEndMs]);
  for (const [startMs, endMs] of clippedBusy) {
    points.add(startMs);
    points.add(endMs);
  }
  for (const [startMs, endMs] of clippedClient) {
    points.add(startMs);
    points.add(endMs);
  }

  const sortedPoints = Array.from(points).sort((left, right) => left - right);
  for (let index = 0; index < sortedPoints.length - 1; index += 1) {
    const segmentStart = sortedPoints[index];
    const segmentEnd = sortedPoints[index + 1];
    if (segmentEnd <= segmentStart) {
      continue;
    }

    const midpoint = segmentStart + Math.floor((segmentEnd - segmentStart) / 2);
    const segmentBusy = clippedBusy.some(([startMs, endMs]) => midpoint >= startMs && midpoint < endMs);
    if (!segmentBusy) {
      continue;
    }

    const coveredByClientMeeting = clippedClient.some(([startMs, endMs]) => midpoint >= startMs && midpoint < endMs);
    if (!coveredByClientMeeting) {
      return true;
    }
  }

  return false;
}

function buildAvailabilityCalendarModel({
  busyIntervalsUtc,
  clientMeetingsUtc,
  nonClientBusyIntervalsUtc,
  hostTimezone,
  advisingDays,
  searchStartIso,
  searchEndIso,
  workdayStartHour,
  workdayEndHour,
  slotMinutes,
  maxCells
}) {
  const acceptedWeekdays = normalizeWeekdays(advisingDays);
  const searchStartUtc = DateTime.fromISO(searchStartIso, { zone: "utc" });
  const searchEndUtc = DateTime.fromISO(searchEndIso, { zone: "utc" });
  if (!searchStartUtc.isValid || !searchEndUtc.isValid || searchEndUtc <= searchStartUtc) {
    return {
      days: [],
      rows: [],
      openSlotCount: 0,
      busySlotCount: 0,
      clientMeetingSlotCount: 0,
      clientOverlapSlotCount: 0,
      slotMinutes
    };
  }

  const busyIntervals = busyIntervalsUtc
    .map((item) => {
      const start = DateTime.fromISO(item.startIso, { zone: "utc" });
      const end = DateTime.fromISO(item.endIso, { zone: "utc" });
      const interval = Interval.fromDateTimes(start, end);
      if (!interval.isValid) {
        return null;
      }

      return {
        interval,
        startMs: start.toMillis(),
        endMs: end.toMillis()
      };
    })
    .filter(Boolean);
  const clientMeetings = (Array.isArray(clientMeetingsUtc) ? clientMeetingsUtc : [])
    .map((item) => {
      const start = DateTime.fromISO(item.startIso, { zone: "utc" });
      const end = DateTime.fromISO(item.endIso, { zone: "utc" });
      const interval = Interval.fromDateTimes(start, end);
      if (!interval.isValid) {
        return null;
      }

      return {
        interval,
        startMs: start.toMillis(),
        endMs: end.toMillis(),
        title: normalizeMeetingDisplayTitle(item.title),
        advisorResponseStatus: normalizeAdvisorResponseStatus(item.advisorResponseStatus)
      };
    })
    .filter(Boolean);
  const nonClientBusyIntervals = (Array.isArray(nonClientBusyIntervalsUtc) ? nonClientBusyIntervalsUtc : [])
    .map((item) => {
      const start = DateTime.fromISO(item.startIso, { zone: "utc" });
      const end = DateTime.fromISO(item.endIso, { zone: "utc" });
      const interval = Interval.fromDateTimes(start, end);
      if (!interval.isValid) {
        return null;
      }

      return {
        interval,
        startMs: start.toMillis(),
        endMs: end.toMillis()
      };
    })
    .filter(Boolean);

  let days = [];
  let localDay = searchStartUtc.setZone(hostTimezone).startOf("day");
  const finalLocalDay = searchEndUtc.setZone(hostTimezone).endOf("day");
  while (localDay <= finalLocalDay) {
    const localWeekday = localDay.toFormat("ccc").toLowerCase();
    if (acceptedWeekdays.has(localWeekday)) {
      days.push({
        isoDate: localDay.toISODate(),
        weekdayLabel: localDay.toFormat("EEE"),
        dateLabel: localDay.toFormat("MMM dd"),
        fullLabel: localDay.toFormat("cccc, MMMM dd, yyyy")
      });
    }

    localDay = localDay.plus({ days: 1 });
  }

  if (days.length === 0) {
    return {
      days,
      rows: [],
      openSlotCount: 0,
      busySlotCount: 0,
      clientMeetingSlotCount: 0,
      clientOverlapSlotCount: 0,
      slotMinutes
    };
  }

  const firstDay = DateTime.fromISO(days[0].isoDate, { zone: hostTimezone });
  const dayStart = firstDay.set({ hour: workdayStartHour, minute: 0, second: 0, millisecond: 0 });
  const dayEnd = firstDay.set({ hour: workdayEndHour, minute: 0, second: 0, millisecond: 0 });
  const slotsPerDay = Math.max(1, Math.floor(dayEnd.diff(dayStart, "minutes").minutes / slotMinutes));
  const safeMaxCells = Number.isFinite(maxCells) ? Math.max(24, Math.trunc(maxCells)) : 240;
  if (days.length * slotsPerDay > safeMaxCells) {
    const maxDays = Math.max(1, Math.floor(safeMaxCells / slotsPerDay));
    days = days.slice(0, maxDays);
  }

  const rows = [];
  let openSlotCount = 0;
  let busySlotCount = 0;
  let clientMeetingSlotCount = 0;
  let clientOverlapSlotCount = 0;

  let rowStart = dayStart;
  while (rowStart.plus({ minutes: slotMinutes }) <= dayEnd) {
    const rowOffsetMinutes = rowStart.diff(dayStart, "minutes").minutes;
    const cells = days.map((day) => {
      const dayDate = DateTime.fromISO(day.isoDate, { zone: hostTimezone });
      const slotStartLocal = dayDate
        .set({ hour: workdayStartHour, minute: 0, second: 0, millisecond: 0 })
        .plus({ minutes: rowOffsetMinutes });
      const slotEndLocal = slotStartLocal.plus({ minutes: slotMinutes });
      const intervalUtc = Interval.fromDateTimes(slotStartLocal.toUTC(), slotEndLocal.toUTC());
      const slotStartMs = slotStartLocal.toUTC().toMillis();
      const slotEndMs = slotEndLocal.toUTC().toMillis();
      const busyInSlot = busyIntervals.filter((busyInterval) => busyInterval.interval.overlaps(intervalUtc));
      const meetingsInSlot = clientMeetings.filter((meeting) => meeting.interval.overlaps(intervalUtc));
      const meetingDetails = meetingsInSlot.map((meeting) => ({
        title: meeting.title,
        advisorResponseStatus: meeting.advisorResponseStatus
      }));
      const hasClientMeeting = meetingDetails.length > 0;
      const hasOverlap = hasClientMeeting
        ? hasBusyOutsideClientMeetings({
            slotStartMs,
            slotEndMs,
            busyIntervals: busyInSlot,
            clientMeetings: meetingsInSlot,
            nonClientBusyIntervals
          })
        : false;
      const isBusy = busyInSlot.length > 0 || hasClientMeeting;
      const clientMeetingState = hasClientMeeting
        ? meetingDetails.some((meeting) => meeting.advisorResponseStatus === "accepted")
          ? "accepted"
          : "pending"
        : null;
      const hostLabel = slotStartLocal.toFormat("h:mm a");

      if (isBusy) {
        busySlotCount += 1;
      } else {
        openSlotCount += 1;
      }
      if (hasClientMeeting) {
        clientMeetingSlotCount += 1;
      }
      if (hasOverlap) {
        clientOverlapSlotCount += 1;
      }

      return {
        status: isBusy ? "busy" : "open",
        slotStartUtc: slotStartLocal.toUTC().toISO(),
        slotEndUtc: slotEndLocal.toUTC().toISO(),
        hostLabel,
        hostEndLabel: slotEndLocal.toFormat("h:mm a"),
        hasClientMeeting,
        clientMeetingState,
        clientMeetings: meetingDetails,
        hasOverlap
      };
    });

    rows.push({
      cells
    });

    rowStart = rowStart.plus({ minutes: slotMinutes });
  }

  return {
    days,
    rows,
    openSlotCount,
    busySlotCount,
    clientMeetingSlotCount,
    clientOverlapSlotCount,
    slotMinutes
  };
}

function formatMeetingStateLabel(advisorResponseStatus) {
  return advisorResponseStatus === "accepted" ? "Accepted" : "Pending";
}

function buildAdvisorMergeKey(slot) {
  if (!slot?.hasClientMeeting || !Array.isArray(slot.clientMeetings) || slot.clientMeetings.length !== 1) {
    return null;
  }

  const meeting = slot.clientMeetings[0];
  return [
    slot.status,
    slot.clientMeetingState ?? "",
    slot.hasOverlap ? "1" : "0",
    meeting.title ?? "",
    meeting.advisorResponseStatus ?? ""
  ].join("|");
}

function buildAdvisorCellSpanPlan(rows, dayCount) {
  const plan = rows.map(() =>
    Array.from({ length: dayCount }, () => ({
      render: true,
      rowspan: 1
    }))
  );

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    let rowIndex = 0;
    while (rowIndex < rows.length) {
      const slot = rows[rowIndex]?.cells?.[dayIndex];
      const mergeKey = buildAdvisorMergeKey(slot);
      if (!mergeKey) {
        rowIndex += 1;
        continue;
      }

      let span = 1;
      while (rowIndex + span < rows.length) {
        const nextSlot = rows[rowIndex + span]?.cells?.[dayIndex];
        if (buildAdvisorMergeKey(nextSlot) !== mergeKey) {
          break;
        }
        span += 1;
      }

      plan[rowIndex][dayIndex] = {
        render: true,
        rowspan: span
      };
      for (let offset = 1; offset < span; offset += 1) {
        plan[rowIndex + offset][dayIndex] = {
          render: false,
          rowspan: 0
        };
      }

      rowIndex += span;
    }
  }

  return plan;
}

function buildAvailabilityPage({
  calendarModel,
  hostTimezone,
  expiresAtMs,
  tokenParamName,
  token,
  weekOffset,
  windowLabel,
  clientDisplayName,
  clientReference
}) {
  const expiresAtLabel = new Date(expiresAtMs).toLocaleString("en-US", {
    timeZone: hostTimezone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
  const advisorCellSpanPlan = buildAdvisorCellSpanPlan(calendarModel.rows, calendarModel.days.length);
  const dayTables = calendarModel.days
    .map((day, dayIndex) => {
      const dayHeader = `<th class="day-header" scope="colgroup" colspan="2" title="${escapeHtml(day.fullLabel)}"><div class="weekday">${escapeHtml(
        day.weekdayLabel
      )}</div><div class="date">${escapeHtml(day.dateLabel)}</div></th>`;
      const daySubHeaders =
        '<th class="sub-header local-time-header"><span class="local-header-title">Local timezone</span><span class="local-header-zone">Detecting...</span></th><th class="sub-header advisor-time-header">Advisor Calendar</th>';

      const dayRows = calendarModel.rows
        .map((row, rowIndex) => {
          const slot = row.cells[dayIndex];
          const localCell = `<td class="slot local-slot ${slot.status}" data-slot-start-utc="${escapeHtml(slot.slotStartUtc)}">
            <div class="slot-local">Detecting...</div>
          </td>`;

          const spanPlan = advisorCellSpanPlan[rowIndex]?.[dayIndex] ?? { render: true, rowspan: 1 };
          if (!spanPlan.render) {
            return `<tr class="slot-row" data-row-index="${rowIndex}">${localCell}</tr>`;
          }

          const clientPill = slot.hasClientMeeting
            ? `<div class="slot-pill client-${slot.clientMeetingState}">Your meeting (${slot.clientMeetingState === "accepted" ? "accepted" : "pending"})</div>`
            : "";
          const overlapPill = slot.hasOverlap ? '<div class="slot-pill overlap">Potential conflict</div>' : "";
          const meetingDetails = slot.hasClientMeeting
            ? `<div class="client-meeting-list">${slot.clientMeetings
                .map(
                  (meeting) =>
                    `<div class="client-meeting-item"><span class="meeting-title">${escapeHtml(
                      meeting.title
                    )}</span><span class="meeting-state ${escapeHtml(meeting.advisorResponseStatus)}">${formatMeetingStateLabel(
                      meeting.advisorResponseStatus
                    )}</span></div>`
                )
                .join("")}</div>`
            : "";
          const advisorSlotClass = [
            "slot",
            "advisor-slot",
            slot.status,
            slot.hasClientMeeting ? `client-${slot.clientMeetingState}` : "",
            slot.hasOverlap ? "client-overlap" : "",
            spanPlan.rowspan > 1 ? "merged-span" : ""
          ]
            .filter(Boolean)
            .join(" ");
          const rowspanAttr = spanPlan.rowspan > 1 ? ` rowspan="${spanPlan.rowspan}"` : "";
          const hostTimeLabel =
            spanPlan.rowspan > 1
              ? `${slot.hostLabel} - ${calendarModel.rows[rowIndex + spanPlan.rowspan - 1]?.cells?.[dayIndex]?.hostEndLabel ?? slot.hostEndLabel}`
              : slot.hostLabel;

          return `<tr class="slot-row" data-row-index="${rowIndex}">${localCell}
          <td class="${advisorSlotClass}"${rowspanAttr}>
            <div class="slot-pill ${slot.status}">${slot.status === "busy" ? "Busy" : "Open"}</div>
            ${clientPill}
            ${overlapPill}
            <div class="slot-host">${escapeHtml(hostTimeLabel)}</div>
            ${meetingDetails}
          </td></tr>`;
        })
        .join("");

      return `<section class="day-card">
          <table class="calendar-grid day-grid" data-day-index="${dayIndex}">
            <colgroup>
              <col class="col-local" />
              <col class="col-advisor" />
            </colgroup>
            <thead>
              <tr>${dayHeader}</tr>
              <tr>${daySubHeaders}</tr>
            </thead>
            <tbody>${dayRows}</tbody>
          </table>
        </section>`;
    })
    .join("");

  const availabilityBody =
    calendarModel.days.length > 0 && calendarModel.rows.length > 0
      ? `<div class="calendar-carousel" id="calendar-carousel" tabindex="0" aria-label="Availability day carousel">
          <button type="button" class="carousel-nav prev" id="carousel-prev" aria-label="Show previous day card">&lt;</button>
          <div class="carousel-viewport" id="carousel-viewport">
            <div class="calendar-days" id="calendar-days">${dayTables}</div>
          </div>
          <button type="button" class="carousel-nav next" id="carousel-next" aria-label="Show next day card">&gt;</button>
        </div>
        <p class="carousel-status" id="carousel-status" aria-live="polite"></p>`
      : '<section class="empty"><h2>No advising windows configured</h2><p>No calendar columns were generated for the configured advising days.</p></section>';

  const encodedToken = encodeURIComponent(token);
  const encodedClientReference = clientReference ? encodeURIComponent(clientReference) : "";
  const clientReferenceQuery = encodedClientReference ? `&for=${encodedClientReference}` : "";
  const previousWeekOffset = weekOffset - 1;
  const nextWeekOffset = weekOffset + 1;
  const previousHref = `?${tokenParamName}=${encodedToken}&weekOffset=${previousWeekOffset}${clientReferenceQuery}`;
  const nextHref = `?${tokenParamName}=${encodedToken}&weekOffset=${nextWeekOffset}${clientReferenceQuery}`;
  const previousButton =
    previousWeekOffset < -8
      ? '<span class="nav-link disabled" aria-disabled="true">&lt; Previous Week</span>'
      : `<a class="nav-link" href="${escapeHtml(previousHref)}">&lt; Previous Week</a>`;
  const nextButton =
    nextWeekOffset > 52
      ? '<span class="nav-link disabled" aria-disabled="true">Next Week &gt;</span>'
      : `<a class="nav-link" href="${escapeHtml(nextHref)}">Next Week &gt;</a>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Advisor Availability</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #111827; background: #f8fafc; }
      main { max-width: 1200px; margin: 0 auto; }
      h1 { margin-bottom: 8px; }
      code { background: #eef2ff; border-radius: 4px; padding: 1px 4px; }
      .muted { color: #4b5563; margin-top: 0; }
      .legend { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; color: #374151; font-size: 14px; }
      .legend-pill { display: inline-block; padding: 3px 8px; border-radius: 999px; font-weight: 600; font-size: 12px; border: 1px solid; }
      .legend-pill.open { background: #e8f5e9; color: #065f46; border-color: #9dd7a6; }
      .legend-pill.busy { background: #eceff1; color: #374151; border-color: #cbd5e1; }
      .legend-pill.client-accepted { background: #dcfce7; color: #166534; border-color: #86efac; }
      .legend-pill.client-pending { background: #fef9c3; color: #854d0e; border-color: #fde68a; }
      .legend-pill.overlap { background: #fee2e2; color: #991b1b; border-color: #fecaca; }
      .summary { font-size: 14px; color: #374151; margin-bottom: 12px; }
      .week-nav { display: flex; align-items: center; justify-content: space-between; margin: 14px 0; gap: 10px; }
      .week-range { font-size: 14px; font-weight: 700; color: #0f172a; text-align: center; flex: 1; }
      .nav-link { text-decoration: none; color: #1d4ed8; font-size: 14px; font-weight: 600; }
      .nav-link:hover { text-decoration: underline; }
      .nav-link.disabled { color: #94a3b8; pointer-events: none; }
      .calendar-carousel { display: flex; align-items: center; gap: 10px; }
      .carousel-viewport { flex: 1; overflow-x: auto; scroll-behavior: smooth; border-radius: 16px; padding: 2px; }
      .carousel-viewport::-webkit-scrollbar { height: 10px; }
      .carousel-viewport::-webkit-scrollbar-track { background: #e2e8f0; border-radius: 999px; }
      .carousel-viewport::-webkit-scrollbar-thumb { background: #94a3b8; border-radius: 999px; }
      .carousel-nav { width: 36px; height: 36px; border-radius: 999px; border: 1px solid #cbd5e1; background: #fff; color: #1e293b; font-weight: 700; cursor: pointer; }
      .carousel-nav:hover { background: #f8fafc; }
      .carousel-nav:disabled { opacity: 0.4; cursor: not-allowed; }
      .calendar-carousel.single-day .carousel-nav { visibility: hidden; pointer-events: none; }
      .carousel-status { margin: 8px 0 10px; color: #475569; font-size: 12px; font-weight: 600; text-align: right; }
      .calendar-carousel.single-day + .carousel-status { visibility: hidden; }
      .calendar-days { display: flex; gap: 24px; align-items: stretch; width: max-content; min-width: 100%; }
      .day-card { background: #fff; border: 1px solid #d1d5db; border-radius: 14px; overflow: hidden; flex: 0 0 auto; width: 100%; }
      .calendar-grid { width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; }
      .calendar-grid col.col-local { width: 30%; }
      .calendar-grid col.col-advisor { width: 70%; }
      .calendar-grid thead th { background: #f1f5f9; z-index: 2; border-bottom: 1px solid #cbd5e1; }
      .calendar-grid th, .calendar-grid td { border-right: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; padding: 8px; vertical-align: top; }
      .calendar-grid th:last-child, .calendar-grid td:last-child { border-right: 0; }
      .day-header { text-align: center; border-right: 0; }
      .sub-header.advisor-time-header, .calendar-grid tbody td.advisor-slot { border-right: 0; }
      .weekday { font-size: 12px; text-transform: uppercase; color: #64748b; letter-spacing: 0.04em; }
      .date { font-size: 14px; font-weight: 700; color: #0f172a; }
      .sub-header { text-align: left; font-size: 11px; color: #475569; font-weight: 700; }
      .sub-header.local-time-header { white-space: normal; }
      .local-header-title { display: block; line-height: 1.2; }
      .local-header-zone { display: block; margin-top: 2px; line-height: 1.2; font-size: 10px; font-weight: 600; color: #64748b; overflow-wrap: anywhere; }
      .slot { min-height: 60px; }
      .slot.open { background: #f4fbf6; }
      .slot.busy { background: #f8fafc; }
      .slot.client-accepted { background: #ecfdf5; }
      .slot.client-pending { background: #fffbeb; }
      .slot.client-overlap { box-shadow: inset 0 0 0 2px #fca5a5; }
      .slot-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; border: 1px solid; }
      .slot-pill.open { color: #065f46; background: #dcfce7; border-color: #86efac; }
      .slot-pill.busy { color: #334155; background: #e2e8f0; border-color: #cbd5e1; }
      .slot-pill.client-accepted { color: #166534; background: #dcfce7; border-color: #86efac; margin-top: 4px; }
      .slot-pill.client-pending { color: #854d0e; background: #fef3c7; border-color: #fcd34d; margin-top: 4px; }
      .slot-pill.overlap { color: #991b1b; background: #fee2e2; border-color: #fca5a5; margin-top: 4px; }
      .slot-host { margin-top: 6px; font-size: 11px; font-weight: 700; color: #0f172a; }
      .advisor-slot.merged-span .slot-host { margin-top: 8px; }
      .slot-local { margin-top: 6px; font-size: 11px; font-weight: 600; color: #475569; }
      .local-slot .slot-local { white-space: normal; line-height: 1.25; overflow-wrap: anywhere; }
      .client-meeting-list { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
      .client-meeting-item { font-size: 11px; line-height: 1.3; display: flex; flex-direction: column; gap: 2px; padding: 4px 6px; border: 1px solid #d1d5db; border-radius: 6px; background: #ffffff; }
      .meeting-title { font-weight: 600; color: #0f172a; word-break: break-word; }
      .meeting-state { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
      .meeting-state.accepted { color: #166534; }
      .meeting-state.pending { color: #854d0e; }
      .empty { background: #fff; border: 1px solid #d1d5db; border-radius: 10px; padding: 16px; }
      .note { font-size: 13px; color: #4b5563; margin-top: 16px; }
      @media (max-width: 768px) {
        .calendar-carousel { gap: 6px; }
        .carousel-nav { width: 30px; height: 30px; }
        .calendar-days { gap: 14px; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Available Times</h1>
      ${
        clientDisplayName
          ? `<p class="muted">Availability for <code>${escapeHtml(clientDisplayName)}</code></p>`
          : ""
      }
      <p class="muted">Calendar-style view of open and busy blocks. Busy meeting details are hidden by default; meetings tied to your domain are shown.</p>
      <p class="muted">Advisor timezone: <code>${escapeHtml(hostTimezone)}</code> | Local timezone: <code id="local-timezone-code">Detecting...</code></p>
      <p class="muted">Link expires: ${escapeHtml(expiresAtLabel)} (${escapeHtml(hostTimezone)})</p>
      <div class="legend">
        <span class="legend-pill open">Open</span>
        <span class="legend-pill busy">Busy</span>
        <span class="legend-pill client-accepted">Your Meeting Accepted</span>
        <span class="legend-pill client-pending">Your Meeting Pending</span>
        <span class="legend-pill overlap">Advisor Calendar Conflict</span>
      </div>
      <p class="summary">Open slots: ${calendarModel.openSlotCount} | Busy blocks: ${calendarModel.busySlotCount} | Your meeting slots: ${calendarModel.clientMeetingSlotCount} | Overlaps: ${calendarModel.clientOverlapSlotCount}</p>
      <div class="week-nav">
        ${previousButton}
        <div class="week-range">${escapeHtml(windowLabel)}</div>
        ${nextButton}
      </div>
      ${availabilityBody}
      <p class="note">Reply to the email with the time that works best and the agent will continue the booking flow.</p>
    </main>
    <script>
      (function () {
        function setLocalHeaderLabel(headerCell, timezoneLabel) {
          headerCell.innerHTML = '';
          var title = document.createElement('span');
          title.className = 'local-header-title';
          title.textContent = 'Local timezone';
          headerCell.appendChild(title);

          var zone = document.createElement('span');
          zone.className = 'local-header-zone';
          zone.textContent = timezoneLabel;
          headerCell.appendChild(zone);
        }

        function syncSlotRowHeights() {
          var dayTables = Array.prototype.slice.call(document.querySelectorAll('.day-grid'));
          if (dayTables.length <= 1) {
            return;
          }

          dayTables.forEach(function (table) {
            var rows = table.querySelectorAll('tbody tr.slot-row');
            rows.forEach(function (row) {
              row.style.height = '';
            });
          });

          var maxRowCount = 0;
          dayTables.forEach(function (table) {
            var rowCount = table.querySelectorAll('tbody tr.slot-row').length;
            if (rowCount > maxRowCount) {
              maxRowCount = rowCount;
            }
          });

          for (var rowIndex = 0; rowIndex < maxRowCount; rowIndex += 1) {
            var maxHeight = 0;
            dayTables.forEach(function (table) {
              var row = table.querySelector('tbody tr.slot-row[data-row-index="' + rowIndex + '"]');
              if (!row) {
                return;
              }

              var measuredHeight = row.getBoundingClientRect().height;
              if (measuredHeight > maxHeight) {
                maxHeight = measuredHeight;
              }
            });

            if (maxHeight <= 0) {
              continue;
            }

            var targetHeight = Math.ceil(maxHeight);
            dayTables.forEach(function (table) {
              var row = table.querySelector('tbody tr.slot-row[data-row-index="' + rowIndex + '"]');
              if (row) {
                row.style.height = targetHeight + 'px';
              }
            });
          }
        }

        function getCardsPerView() {
          var viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
          if (viewportWidth >= 1200) {
            return 3;
          }
          if (viewportWidth >= 768) {
            return 2;
          }
          return 1;
        }

        function initializeDayCarousel() {
          var carousel = document.getElementById('calendar-carousel');
          var viewport = document.getElementById('carousel-viewport');
          var track = document.getElementById('calendar-days');
          if (!carousel || !viewport || !track) {
            return null;
          }

          var cards = Array.prototype.slice.call(track.querySelectorAll('.day-card'));
          var previousButton = document.getElementById('carousel-prev');
          var nextButton = document.getElementById('carousel-next');
          var statusNode = document.getElementById('carousel-status');
          var scrollTimer = null;
          var resizeTimer = null;

          function readGapPx() {
            var styles = window.getComputedStyle(track);
            var rawGap = styles.columnGap || styles.gap || '24px';
            var parsedGap = Number.parseFloat(rawGap);
            return Number.isFinite(parsedGap) ? parsedGap : 24;
          }

          function measureCardStep() {
            if (cards.length === 0) {
              return 0;
            }

            return cards[0].getBoundingClientRect().width + readGapPx();
          }

          function measureMaxScrollLeft() {
            return Math.max(0, track.scrollWidth - viewport.clientWidth);
          }

          function clampVisibleStart(visibleStart, cardsPerView) {
            var maxStart = Math.max(0, cards.length - cardsPerView);
            return Math.max(0, Math.min(visibleStart, maxStart));
          }

          function updateCarouselState() {
            var cardsPerView = getCardsPerView();
            var step = measureCardStep();
            var maxScrollLeft = measureMaxScrollLeft();
            var visibleStart = step > 0 ? Math.round(viewport.scrollLeft / step) : 0;
            visibleStart = clampVisibleStart(visibleStart, cardsPerView);
            var visibleEnd = Math.min(cards.length, visibleStart + cardsPerView);

            if (statusNode) {
              statusNode.textContent =
                cards.length > 0 ? String(visibleStart + 1) + '-' + String(visibleEnd) + ' of ' + String(cards.length) : '0 of 0';
            }

            if (previousButton) {
              previousButton.disabled = viewport.scrollLeft <= 1;
            }
            if (nextButton) {
              nextButton.disabled = viewport.scrollLeft >= maxScrollLeft - 1;
            }

            carousel.classList.toggle('single-day', cards.length <= cardsPerView);
          }

          function layoutCarousel() {
            var cardsPerView = getCardsPerView();
            var gapPx = readGapPx();
            var viewportWidth = viewport.clientWidth;
            if (viewportWidth <= 0 || cards.length === 0) {
              return;
            }

            var cardWidth = (viewportWidth - gapPx * (cardsPerView - 1)) / cardsPerView;
            var normalizedCardWidth = Math.max(240, Math.floor(cardWidth));
            cards.forEach(function (card) {
              card.style.width = normalizedCardWidth + 'px';
            });

            var maxScrollLeft = measureMaxScrollLeft();
            if (viewport.scrollLeft > maxScrollLeft) {
              viewport.scrollLeft = maxScrollLeft;
            }

            updateCarouselState();
            syncSlotRowHeights();
          }

          function scrollByOneCard(direction) {
            var step = measureCardStep();
            if (step <= 0) {
              return;
            }

            viewport.scrollBy({
              left: direction * step,
              behavior: 'smooth'
            });
          }

          if (previousButton) {
            previousButton.addEventListener('click', function () {
              scrollByOneCard(-1);
            });
          }
          if (nextButton) {
            nextButton.addEventListener('click', function () {
              scrollByOneCard(1);
            });
          }

          viewport.addEventListener('scroll', function () {
            if (scrollTimer) {
              clearTimeout(scrollTimer);
            }
            scrollTimer = setTimeout(function () {
              updateCarouselState();
            }, 50);
          });

          carousel.addEventListener('keydown', function (event) {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              scrollByOneCard(-1);
            }
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              scrollByOneCard(1);
            }
          });

          window.addEventListener('resize', function () {
            if (resizeTimer) {
              clearTimeout(resizeTimer);
            }
            resizeTimer = setTimeout(function () {
              layoutCarousel();
            }, 90);
          });

          layoutCarousel();
          return {
            layoutCarousel: layoutCarousel
          };
        }

        var localTimezone = '';
        try {
          localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        } catch (_error) {
          localTimezone = '';
        }

        var timezoneCode = document.getElementById('local-timezone-code');
        var localHeaders = document.querySelectorAll('.local-time-header');
        if (!localTimezone) {
          if (timezoneCode) {
            timezoneCode.textContent = 'Unavailable';
          }
          localHeaders.forEach(function (headerCell) {
            setLocalHeaderLabel(headerCell, 'Unavailable');
          });
          return;
        }

        if (timezoneCode) {
          timezoneCode.textContent = localTimezone;
        }
        localHeaders.forEach(function (headerCell) {
          setLocalHeaderLabel(headerCell, localTimezone);
        });

        var timeFormatter = new Intl.DateTimeFormat('en-US', {
          timeZone: localTimezone,
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
        var localSlotCells = document.querySelectorAll('.local-slot[data-slot-start-utc]');
        localSlotCells.forEach(function (slotCell) {
          var slotStartIso = slotCell.getAttribute('data-slot-start-utc');
          if (!slotStartIso) {
            return;
          }

          var date = new Date(slotStartIso);
          if (Number.isNaN(date.getTime())) {
            return;
          }

          var slotLabel = slotCell.querySelector('.slot-local');
          if (slotLabel) {
            slotLabel.textContent = timeFormatter.format(date);
          }
        });

        if (window.requestAnimationFrame) {
          window.requestAnimationFrame(function () {
            var carouselController = initializeDayCarousel();
            if (!carouselController) {
              syncSlotRowHeights();
            }
          });
        } else {
          var fallbackCarousel = initializeDayCarousel();
          if (!fallbackCarousel) {
            syncSlotRowHeights();
          }
        }
      })();
    </script>
  </body>
</html>`;
}

function availabilityErrorPage(message) {
  return htmlResponse(
    403,
    `<!doctype html><html><body><h1>Availability Link Error</h1><p>${escapeHtml(message)}</p></body></html>`
  );
}

async function lookupAvailabilityContext({
  deps,
  calendarMode,
  connectionsTableName,
  advisorId,
  googleOauthSecretArn,
  searchStartIso,
  searchEndIso,
  clientEmail
}) {
  const lookupWithOauthConfig = async ({ oauthConfig, advisorEmailHint }) => {
    const busyIntervals = await deps.lookupBusyIntervals({
      oauthConfig,
      windowStartIso: searchStartIso,
      windowEndIso: searchEndIso,
      fetchImpl: deps.fetchImpl
    });

    let clientMeetings = [];
    let nonClientBusyIntervals = [];
    if (clientEmail && typeof deps.lookupClientMeetings === "function") {
      try {
        const clientMeetingOverlay = await deps.lookupClientMeetings({
          oauthConfig,
          windowStartIso: searchStartIso,
          windowEndIso: searchEndIso,
          clientEmail,
          advisorEmailHint,
          fetchImpl: deps.fetchImpl
        });
        if (Array.isArray(clientMeetingOverlay)) {
          clientMeetings = clientMeetingOverlay;
        } else {
          clientMeetings = Array.isArray(clientMeetingOverlay?.clientMeetings) ? clientMeetingOverlay.clientMeetings : [];
          nonClientBusyIntervals = Array.isArray(clientMeetingOverlay?.nonClientBusyIntervals)
            ? clientMeetingOverlay.nonClientBusyIntervals
            : [];
        }
      } catch {
        clientMeetings = [];
        nonClientBusyIntervals = [];
      }
    }

    return {
      busyIntervals,
      clientMeetings,
      nonClientBusyIntervals
    };
  };

  if (calendarMode === "mock") {
    return {
      busyIntervals: [],
      clientMeetings: [],
      nonClientBusyIntervals: []
    };
  }

  if (calendarMode === "google") {
    if (!googleOauthSecretArn) {
      throw new Error("GOOGLE_OAUTH_SECRET_ARN is required for CALENDAR_MODE=google");
    }

    const secretString = await deps.getSecretString(googleOauthSecretArn);
    const oauthConfig = parseGoogleOauthSecret(secretString);
    return lookupWithOauthConfig({ oauthConfig });
  }

  if (calendarMode === "connection") {
    if (!connectionsTableName) {
      throw new Error("CONNECTIONS_TABLE_NAME is required for CALENDAR_MODE=connection");
    }

    const connection = await deps.getPrimaryConnection(connectionsTableName, advisorId);
    if (!connection) {
      return {
        busyIntervals: [],
        clientMeetings: [],
        nonClientBusyIntervals: []
      };
    }

    if (connection.provider === "mock") {
      return {
        busyIntervals: [],
        clientMeetings: [],
        nonClientBusyIntervals: []
      };
    }

    if (connection.provider === "google") {
      if (!connection.secretArn) {
        throw new Error("Google connection is missing secretArn");
      }

      const secretString = await deps.getSecretString(connection.secretArn);
      const oauthConfig = parseGoogleOauthSecret(secretString);
      return lookupWithOauthConfig({
        oauthConfig,
        advisorEmailHint: connection.accountEmail
      });
    }

    throw new Error(`Unsupported provider for availability lookup: ${connection.provider}`);
  }

  throw new Error(`Unsupported CALENDAR_MODE value: ${calendarMode}`);
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

function validateEnumValue(rawValue, allowedValues, fieldName, defaultValue) {
  const normalized = String(rawValue ?? defaultValue)
    .trim()
    .toLowerCase();
  if (!allowedValues.has(normalized)) {
    throw new Error(`${fieldName} must be one of: ${Array.from(allowedValues).join(", ")}`);
  }

  return normalized;
}

function parseFeedbackPayload(payload, defaultSource = "advisor") {
  const requestId = String(payload.requestId ?? "").trim();
  const responseId = String(payload.responseId ?? "").trim();
  if (!requestId || !responseId) {
    throw new Error("requestId and responseId are required");
  }

  const feedbackType = validateEnumValue(payload.feedbackType, FEEDBACK_TYPE_VALUES, "feedbackType", "other");
  const feedbackReason = validateEnumValue(
    payload.feedbackReason,
    FEEDBACK_REASON_VALUES,
    "feedbackReason",
    "other"
  );
  const feedbackSource = validateEnumValue(payload.feedbackSource, FEEDBACK_SOURCE_VALUES, "feedbackSource", defaultSource);

  return {
    requestId,
    responseId,
    feedbackType,
    feedbackReason,
    feedbackSource
  };
}

function parseTraceLookupPath(rawPath) {
  const match = rawPath.match(/^\/advisor\/api\/traces\/([^/]+)$/);
  return match?.[1] ?? null;
}

function parseTraceFeedbackPath(rawPath) {
  const match = rawPath.match(/^\/advisor\/api\/traces\/([^/]+)\/feedback$/);
  return match?.[1] ?? null;
}

function isValidRequestId(requestId) {
  return typeof requestId === "string" && /^[A-Za-z0-9-]{8,128}$/.test(requestId);
}

function parseClientProfilePath(rawPath) {
  const match = rawPath.match(/^\/advisor\/api\/clients\/([^/]+)$/);
  return match?.[1] ?? null;
}

function parsePolicyPresetPath(rawPath) {
  const match = rawPath.match(/^\/advisor\/api\/policies\/([^/]+)$/);
  return match?.[1] ?? null;
}

function parseClientAdvisingDaysOverride(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return null;
  }

  const parsed = parseAdvisingDaysList(rawValue, []);
  if (parsed.length === 0) {
    throw new Error("advisingDaysOverride must include at least one valid weekday");
  }

  return parsed;
}

function parsePolicyAdvisingDays(rawValue) {
  const parsed = parseAdvisingDaysList(rawValue, []);
  if (parsed.length === 0) {
    throw new Error("advisingDays must include at least one valid weekday");
  }

  return parsed;
}

function orderPolicyIds(policyIds) {
  const unique = Array.from(new Set(policyIds.filter(Boolean)));
  unique.sort((left, right) => {
    if (left === "default") {
      return -1;
    }
    if (right === "default") {
      return 1;
    }

    return left.localeCompare(right);
  });

  return unique;
}

function buildPolicyCatalog({ basePolicyPresets, customPolicyRecords }) {
  const mergedPresets = mergeClientPolicyPresets(basePolicyPresets, customPolicyRecords);
  const normalizedCustomRecords = new Map();
  for (const record of Array.isArray(customPolicyRecords) ? customPolicyRecords : []) {
    const normalized = normalizePolicyPresetRecord(record);
    if (!normalized) {
      continue;
    }

    normalizedCustomRecords.set(normalized.policyId, {
      policyId: normalized.policyId,
      advisingDays: normalized.advisingDays,
      createdAt: record.createdAt ?? null,
      updatedAt: record.updatedAt ?? null
    });
  }

  const policyOptions = orderPolicyIds(Object.keys(mergedPresets));
  const policies = policyOptions.map((policyId) => {
    const customRecord = normalizedCustomRecords.get(policyId);
    return {
      policyId,
      advisingDays: mergedPresets[policyId],
      source: customRecord ? "custom" : "system",
      canDelete: Boolean(customRecord),
      createdAt: customRecord?.createdAt ?? null,
      updatedAt: customRecord?.updatedAt ?? null
    };
  });

  return {
    mergedPresets,
    policies,
    policyOptions,
    customPolicyIds: new Set(Array.from(normalizedCustomRecords.keys()))
  };
}

function normalizeClientProfileForApi(clientProfile) {
  return {
    clientId: clientProfile.clientId,
    clientEmail: clientProfile.clientEmail ?? "",
    clientDisplayName: clientProfile.clientDisplayName ?? "Client",
    accessState: normalizeClientAccessState(clientProfile.accessState, "active"),
    policyId: normalizePolicyId(clientProfile.policyId) ?? "default",
    advisingDaysOverride: Array.isArray(clientProfile.advisingDaysOverride) ? clientProfile.advisingDaysOverride : [],
    firstInteractionAt: clientProfile.firstInteractionAt ?? null,
    lastInteractionAt: clientProfile.lastInteractionAt ?? null,
    emailAgentCount: Number(clientProfile.emailAgentCount ?? 0),
    availabilityWebCount: Number(clientProfile.availabilityWebCount ?? 0),
    totalInteractionCount: Number(clientProfile.totalInteractionCount ?? 0),
    updatedAt: clientProfile.updatedAt ?? null
  };
}

function selectTraceMetadata(trace) {
  return {
    requestId: trace.requestId,
    responseId: trace.responseId,
    advisorId: trace.advisorId,
    status: trace.status,
    stage: trace.stage,
    errorCode: trace.errorCode,
    providerStatus: trace.providerStatus,
    channel: trace.channel,
    meetingType: trace.meetingType,
    durationMinutes: trace.durationMinutes,
    suggestionCount: trace.suggestionCount,
    responseMode: trace.responseMode,
    calendarMode: trace.calendarMode,
    llmMode: trace.llmMode,
    llmStatus: trace.llmStatus,
    intentSource: trace.intentSource,
    intentLlmStatus: trace.intentLlmStatus,
    requestedWindowCount: trace.requestedWindowCount,
    fromDomain: trace.fromDomain,
    latencyMs: trace.latencyMs,
    createdAt: trace.createdAt,
    updatedAt: trace.updatedAt,
    feedbackStatus: trace.feedbackStatus,
    feedbackSource: trace.feedbackSource,
    feedbackType: trace.feedbackType,
    feedbackReason: trace.feedbackReason,
    feedbackCount: trace.feedbackCount,
    feedbackUpdatedAt: trace.feedbackUpdatedAt
  };
}

function buildTraceDiagnosis(trace) {
  const categories = [];
  const actions = [];
  const latencyMs = Number(trace.latencyMs ?? 0);

  if (trace.status === "failed") {
    categories.push("processing_failed");
    if (trace.errorCode === "CALENDAR_LOOKUP_FAILED") {
      actions.push("Verify advisor calendar connection and OAuth token validity.");
    }
  }

  if (trace.llmStatus === "fallback") {
    categories.push("llm_fallback");
    actions.push("Check LLM provider key, model availability, and timeout configuration.");
  }

  if (trace.intentLlmStatus === "fallback" && Number(trace.requestedWindowCount ?? 0) === 0) {
    categories.push("intent_fallback");
    actions.push("Intent extraction fell back to parser. Consider asking client for explicit time windows.");
  }

  if (latencyMs > 5 * 60 * 1000) {
    categories.push("sla_breach");
    actions.push("Request exceeded 5 minutes. Inspect Lambda duration and upstream provider latency.");
  } else if (latencyMs > 30 * 1000) {
    categories.push("slow_response");
    actions.push("Response was slow. Inspect calendar/LLM latency from CloudWatch and X-Ray.");
  }

  if (trace.status === "completed" && Number(trace.suggestionCount ?? 0) === 0) {
    categories.push("no_slots_found");
    actions.push("No matching slots were available in the requested time window.");
  }

  if (trace.feedbackType === "incorrect" || trace.feedbackType === "odd") {
    categories.push("user_reported_issue");
    actions.push("Review this trace against client preferences and timezone assumptions.");
  }

  if (categories.length === 0) {
    categories.push("healthy");
  }

  return {
    categories,
    actions: Array.from(new Set(actions)),
    slaTargetMs: 300000,
    withinSla: latencyMs > 0 ? latencyMs <= 300000 : null
  };
}

function advisorAuthErrorPage(message) {
  return htmlResponse(
    403,
    `<!doctype html><html><body><h1>Advisor Access Denied</h1><p>${message}</p></body></html>`
  );
}

function buildAdvisorPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Advisor Portal - Connected Calendars</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; background: #f5f7fb; color: #1f2937; }
      .card { background: #fff; border: 1px solid #d0d7e2; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
      h1 { margin-top: 0; }
      button { padding: 8px 12px; margin-right: 8px; cursor: pointer; }
      input, select { padding: 8px 10px; margin-right: 8px; border: 1px solid #c7ced9; border-radius: 6px; }
      .banner { border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; font-size: 14px; }
      .banner.ok { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
      .banner.error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; border-bottom: 1px solid #e5e7eb; padding: 8px; font-size: 14px; }
      .muted { color: #6b7280; }
      .status { font-weight: 600; }
      .ok { color: #047857; }
      .warn { color: #b45309; }
      .error { color: #b91c1c; }
      code { background: #eef2ff; padding: 2px 6px; border-radius: 4px; }
      pre { background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 12px; overflow: auto; font-size: 12px; }
      .row { margin-top: 10px; }
      .inline-controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .small-button { padding: 4px 8px; font-size: 12px; }
      .small-select { padding: 4px 8px; font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Connected Calendars</h1>
      <div id="statusBanner" style="display:none"></div>
      <p class="muted">Add calendars for availability checks without manually editing AWS secrets.</p>
      <button id="addMock">Add Mock Calendar (Test)</button>
      <button id="googleConnect">Connect Google (Sign In)</button>
      <button id="logout">Logout</button>
      <span class="muted">Google flow requires app credentials configured in backend secret.</span>
    </div>

    <div class="card">
      <h2 style="margin-top:0;">Current Connections</h2>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Account</th>
            <th>Status</th>
            <th>Primary</th>
            <th>Updated</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="connectionsBody"></tbody>
      </table>
    </div>

    <div class="card">
      <h2 style="margin-top:0;">Access Policies</h2>
      <p class="muted">Define reusable client visibility policies (advising days) directly in the portal.</p>
      <div class="row inline-controls">
        <input id="newPolicyId" placeholder="policy id (example: founders)" style="min-width: 220px;" />
        <input id="newPolicyDays" placeholder="days (example: Tue,Wed)" style="min-width: 220px;" />
        <button id="createPolicy">Create Policy</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Policy ID</th>
            <th>Allowed Days</th>
            <th>Type</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="policiesBody"></tbody>
      </table>
    </div>

    <div class="card">
      <h2 style="margin-top:0;">Client Directory</h2>
      <p class="muted">Metadata-only client list with first contact, usage counters, and access policy controls.</p>
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Access</th>
            <th>Policy</th>
            <th>First Contact</th>
            <th>Last Activity</th>
            <th>Email Uses</th>
            <th>Web Uses</th>
            <th>Total</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="clientsBody"></tbody>
      </table>
    </div>

    <div class="card">
      <h2 style="margin-top:0;">Debug Request By ID</h2>
      <p class="muted">Looks up metadata-only trace details. No raw email or calendar content is stored.</p>
      <div class="row">
        <input id="traceRequestId" placeholder="requestId (UUID)" style="min-width: 320px;" />
        <button id="traceLookup">Lookup Trace</button>
      </div>
      <div class="row">
        <select id="feedbackReason">
          <option value="other">Feedback reason: other</option>
          <option value="availability_mismatch">availability_mismatch</option>
          <option value="timezone_issue">timezone_issue</option>
          <option value="tone_quality">tone_quality</option>
          <option value="latency">latency</option>
        </select>
        <button id="markIncorrect">Mark Incorrect</button>
        <button id="markOdd">Mark Odd</button>
        <button id="markHelpful">Mark Helpful</button>
      </div>
      <p id="traceStatus" class="muted">Enter a request ID and click Lookup Trace.</p>
      <pre id="traceResult">{}</pre>
    </div>

    <script>
      let lastTrace = null;
      let policyOptions = ['default', 'weekend', 'monday'];

      function showStatusFromQuery() {
        const banner = document.getElementById('statusBanner');
        const params = new URLSearchParams(window.location.search);
        const connected = params.get('connected');
        const error = params.get('error');

        if (connected === 'google') {
          banner.style.display = 'block';
          banner.className = 'banner ok';
          banner.textContent = 'Google calendar connected successfully.';
        } else if (error) {
          banner.style.display = 'block';
          banner.className = 'banner error';
          banner.textContent = error;
        } else {
          banner.style.display = 'none';
          banner.className = '';
          banner.textContent = '';
        }
      }

      function normalizeTraceRequestId(value) {
        return String(value || '').trim();
      }

      function renderTrace(payload) {
        const pre = document.getElementById('traceResult');
        pre.textContent = JSON.stringify(payload, null, 2);
      }

      function setTraceStatus(text, cssClass) {
        const node = document.getElementById('traceStatus');
        node.className = cssClass || 'muted';
        node.textContent = text;
      }

      async function loadConnections() {
        const response = await fetch('./advisor/api/connections');
        const payload = await response.json();
        const tbody = document.getElementById('connectionsBody');
        tbody.innerHTML = '';

        if (!payload.connections || payload.connections.length === 0) {
          const row = document.createElement('tr');
          row.innerHTML = '<td colspan="6" class="muted">No connections yet.</td>';
          tbody.appendChild(row);
          return;
        }

        for (const connection of payload.connections) {
          const row = document.createElement('tr');
          const statusClass = connection.status === 'connected' ? 'ok' : connection.status === 'error' ? 'error' : 'warn';

          row.innerHTML =
            '<td><code>' + connection.provider + '</code></td>' +
            '<td>' + (connection.accountEmail || '-') + '</td>' +
            '<td><span class="status ' + statusClass + '">' + connection.status + '</span></td>' +
            '<td>' + (connection.isPrimary ? 'Yes' : 'No') + '</td>' +
            '<td>' + (connection.updatedAt || '-') + '</td>' +
            '<td><button data-id="' + connection.connectionId + '">Remove</button></td>';

          row.querySelector('button').addEventListener('click', async () => {
            await fetch('./advisor/api/connections/' + connection.connectionId, { method: 'DELETE' });
            await loadConnections();
          });

          tbody.appendChild(row);
        }
      }

      function escapeHtml(value) {
        return String(value || '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function formatCount(value) {
        const parsed = Number(value || 0);
        return Number.isFinite(parsed) ? String(parsed) : '0';
      }

      function normalizePolicyIdInput(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) {
          return null;
        }

        return /^[a-z0-9_-]{1,32}$/.test(normalized) ? normalized : null;
      }

      function parseAdvisingDaysInput(value) {
        return String(value || '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
      }

      async function loadPolicies() {
        const tbody = document.getElementById('policiesBody');
        tbody.innerHTML = '';

        const response = await fetch('./advisor/api/policies');
        const payload = await response.json();

        if (!response.ok) {
          const row = document.createElement('tr');
          row.innerHTML = '<td colspan="4" class="error">' + escapeHtml(payload.error || 'Unable to load policies.') + '</td>';
          tbody.appendChild(row);
          policyOptions = ['default', 'weekend', 'monday'];
          return;
        }

        const policies = Array.isArray(payload.policies) ? payload.policies : [];
        policyOptions = Array.isArray(payload.policyOptions) && payload.policyOptions.length > 0
          ? payload.policyOptions
          : ['default', 'weekend', 'monday'];

        if (policies.length === 0) {
          const row = document.createElement('tr');
          row.innerHTML = '<td colspan="4" class="muted">No policies configured.</td>';
          tbody.appendChild(row);
          return;
        }

        for (const policy of policies) {
          const row = document.createElement('tr');
          const isCustom = policy.source === 'custom';
          const daysValue = Array.isArray(policy.advisingDays) ? policy.advisingDays.join(',') : '';
          const actionHtml = isCustom
            ? '<div class="inline-controls"><button class="small-button" data-action="save-policy-preset">Save</button><button class="small-button" data-action="delete-policy-preset">Delete</button></div>'
            : '<span class="muted">System policy</span>';

          row.innerHTML =
            '<td><code>' + escapeHtml(policy.policyId || '') + '</code></td>' +
            '<td><input data-role="policy-days" value="' + escapeHtml(daysValue) + '" ' + (isCustom ? '' : 'disabled') + ' /></td>' +
            '<td>' + escapeHtml(policy.source || 'system') + '</td>' +
            '<td>' + actionHtml + '</td>';

          if (isCustom) {
            row.querySelector('[data-action="save-policy-preset"]').addEventListener('click', async () => {
              try {
                const daysInput = row.querySelector('[data-role="policy-days"]');
                const advisingDays = parseAdvisingDaysInput(daysInput.value);
                const updateResponse = await fetch('./advisor/api/policies/' + encodeURIComponent(policy.policyId), {
                  method: 'PATCH',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ advisingDays })
                });
                const updatePayload = await updateResponse.json();
                if (!updateResponse.ok) {
                  throw new Error(updatePayload.error || 'Policy update failed');
                }
                await loadPolicies();
                await loadClients();
              } catch (error) {
                window.alert(error.message || 'Policy update failed');
              }
            });

            row.querySelector('[data-action="delete-policy-preset"]').addEventListener('click', async () => {
              try {
                const deleteResponse = await fetch('./advisor/api/policies/' + encodeURIComponent(policy.policyId), {
                  method: 'DELETE'
                });
                const deletePayload = await deleteResponse.json();
                if (!deleteResponse.ok) {
                  throw new Error(deletePayload.error || 'Policy delete failed');
                }
                await loadPolicies();
                await loadClients();
              } catch (error) {
                window.alert(error.message || 'Policy delete failed');
              }
            });
          }

          tbody.appendChild(row);
        }
      }

      async function createPolicyPreset() {
        const policyIdInput = document.getElementById('newPolicyId');
        const policyDaysInput = document.getElementById('newPolicyDays');
        const policyId = normalizePolicyIdInput(policyIdInput.value);
        const advisingDays = parseAdvisingDaysInput(policyDaysInput.value);

        if (!policyId) {
          throw new Error('Policy id must match [a-z0-9_-] and be <= 32 chars.');
        }
        if (advisingDays.length === 0) {
          throw new Error('Enter at least one advising day (example: Tue,Wed).');
        }

        const response = await fetch('./advisor/api/policies', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ policyId, advisingDays })
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Policy create failed');
        }

        policyIdInput.value = '';
        policyDaysInput.value = '';
        await loadPolicies();
        await loadClients();
      }

      async function updateClientProfile(clientId, patch) {
        const response = await fetch('./advisor/api/clients/' + encodeURIComponent(clientId), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch || {})
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Client update failed');
        }
        return payload;
      }

      async function loadClients() {
        const tbody = document.getElementById('clientsBody');
        tbody.innerHTML = '';
        const response = await fetch('./advisor/api/clients');
        const payload = await response.json();
        if (!response.ok) {
          const row = document.createElement('tr');
          row.innerHTML = '<td colspan="9" class="error">' + escapeHtml(payload.error || 'Unable to load clients.') + '</td>';
          tbody.appendChild(row);
          return;
        }

        const clients = Array.isArray(payload.clients) ? payload.clients : [];
        const availablePolicies =
          Array.isArray(policyOptions) && policyOptions.length > 0
            ? policyOptions
            : Array.isArray(payload.policyOptions) && payload.policyOptions.length > 0
              ? payload.policyOptions
              : ['default', 'weekend', 'monday'];

        if (clients.length === 0) {
          const row = document.createElement('tr');
          row.innerHTML = '<td colspan="9" class="muted">No clients yet.</td>';
          tbody.appendChild(row);
          return;
        }

        for (const client of clients) {
          const row = document.createElement('tr');
          const accessClass = client.accessState === 'active' ? 'ok' : client.accessState === 'blocked' ? 'warn' : 'error';
          const optionsHtml = availablePolicies
            .map((policyId) => {
              const selected = policyId === client.policyId ? ' selected' : '';
              return '<option value="' + escapeHtml(policyId) + '"' + selected + '>' + escapeHtml(policyId) + '</option>';
            })
            .join('');

          row.innerHTML =
            '<td><div>' + escapeHtml(client.clientDisplayName || 'Client') + '</div><div class="muted"><code>' + escapeHtml(client.clientEmail || client.clientId) + '</code></div></td>' +
            '<td><span class="status ' + accessClass + '">' + escapeHtml(client.accessState || 'active') + '</span></td>' +
            '<td><div class="inline-controls"><select class="small-select" data-role="policy">' + optionsHtml + '</select><button class="small-button" data-action="save-policy">Save</button></div></td>' +
            '<td>' + escapeHtml(client.firstInteractionAt || '-') + '</td>' +
            '<td>' + escapeHtml(client.lastInteractionAt || '-') + '</td>' +
            '<td>' + formatCount(client.emailAgentCount) + '</td>' +
            '<td>' + formatCount(client.availabilityWebCount) + '</td>' +
            '<td>' + formatCount(client.totalInteractionCount) + '</td>' +
            '<td><div class="inline-controls"><button class="small-button" data-action="activate">Activate</button><button class="small-button" data-action="block">Block</button><button class="small-button" data-action="delete">Delete</button></div></td>';

          row.querySelector('[data-action="save-policy"]').addEventListener('click', async () => {
            const policySelector = row.querySelector('[data-role="policy"]');
            const policyId = String(policySelector.value || '').trim();
            await updateClientProfile(client.clientId, { policyId });
            await loadClients();
          });

          row.querySelector('[data-action="activate"]').addEventListener('click', async () => {
            await updateClientProfile(client.clientId, { accessState: 'active' });
            await loadClients();
          });

          row.querySelector('[data-action="block"]').addEventListener('click', async () => {
            await updateClientProfile(client.clientId, { accessState: 'blocked' });
            await loadClients();
          });

          row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
            await updateClientProfile(client.clientId, { accessState: 'deleted' });
            await loadClients();
          });

          tbody.appendChild(row);
        }
      }

      document.getElementById('addMock').addEventListener('click', async () => {
        await fetch('./advisor/api/connections/mock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
        await loadConnections();
      });

      document.getElementById('createPolicy').addEventListener('click', async () => {
        try {
          await createPolicyPreset();
        } catch (error) {
          window.alert(error.message || 'Policy create failed');
        }
      });

      document.getElementById('googleConnect').addEventListener('click', () => {
        window.location.href = './advisor/api/connections/google/start';
      });

      document.getElementById('logout').addEventListener('click', async () => {
        await fetch('./advisor/logout', { method: 'POST' });
        window.location.href = './advisor';
      });

      document.getElementById('traceLookup').addEventListener('click', async () => {
        const requestId = normalizeTraceRequestId(document.getElementById('traceRequestId').value);
        if (!requestId) {
          setTraceStatus('requestId is required.', 'error');
          return;
        }

        setTraceStatus('Loading trace...', 'muted');
        const response = await fetch('./advisor/api/traces/' + encodeURIComponent(requestId));
        const payload = await response.json();

        if (!response.ok) {
          lastTrace = null;
          renderTrace(payload);
          setTraceStatus(payload.error || 'Trace lookup failed.', 'error');
          return;
        }

        lastTrace = payload.trace;
        renderTrace(payload);
        setTraceStatus('Trace loaded. You can submit feedback below.', 'ok');
      });

      async function submitAdvisorFeedback(feedbackType) {
        if (!lastTrace || !lastTrace.requestId || !lastTrace.responseId) {
          setTraceStatus('Load a valid trace first.', 'error');
          return;
        }

        const feedbackReason = String(document.getElementById('feedbackReason').value || 'other');
        const response = await fetch(
          './advisor/api/traces/' + encodeURIComponent(lastTrace.requestId) + '/feedback',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              responseId: lastTrace.responseId,
              feedbackType,
              feedbackReason
            })
          }
        );

        const payload = await response.json();
        if (!response.ok) {
          renderTrace(payload);
          setTraceStatus(payload.error || 'Feedback submission failed.', 'error');
          return;
        }

        setTraceStatus('Feedback recorded.', 'ok');
      }

      document.getElementById('markIncorrect').addEventListener('click', async () => {
        await submitAdvisorFeedback('incorrect');
      });

      document.getElementById('markOdd').addEventListener('click', async () => {
        await submitAdvisorFeedback('odd');
      });

      document.getElementById('markHelpful').addEventListener('click', async () => {
        await submitAdvisorFeedback('helpful');
      });

      showStatusFromQuery();
      loadConnections().catch((error) => {
        console.error(error);
      });
      loadPolicies().catch((error) => {
        console.error(error);
      });
      loadClients().catch((error) => {
        console.error(error);
      });
    </script>
  </body>
</html>`;
}

function redirectAdvisorWithError(event, message) {
  const location = `${getBaseUrl(event)}/advisor?error=${encodeURIComponent(message)}`;
  return redirectResponse(location);
}

async function exchangeCodeForTokens({ clientId, clientSecret, code, redirectUri, fetchImpl }) {
  const fetchFn = fetchImpl ?? fetch;
  const form = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  const response = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Google code exchange failed (${response.status}): ${message}`);
  }

  return response.json();
}

async function fetchGoogleUserProfile(accessToken, fetchImpl) {
  const fetchFn = fetchImpl ?? fetch;
  const response = await fetchFn("https://openidconnect.googleapis.com/v1/userinfo", {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    return { email: null };
  }

  return response.json();
}

export function createPortalHandler(overrides = {}) {
  const runtimeDeps = createRuntimeDeps();
  const deps = {
    ...runtimeDeps,
    lookupBusyIntervals: lookupGoogleBusyIntervals,
    lookupClientMeetings: lookupGoogleClientMeetings,
    ...overrides
  };

  return async function handler(event) {
    const method = event.requestContext?.http?.method ?? "GET";
    const rawPath = normalizeRawPath(event.rawPath ?? "/", event.requestContext?.stage);

    const advisorId = process.env.ADVISOR_ID ?? "manoj";
    const appName = process.env.APP_NAME ?? "calendar-agent-spike";
    const stage = process.env.STAGE ?? "dev";
    const connectionsTableName = process.env.CONNECTIONS_TABLE_NAME;
    const clientProfilesTableName = process.env.CLIENT_PROFILES_TABLE_NAME;
    const traceTableName = process.env.TRACE_TABLE_NAME;
    const oauthStateTableName = process.env.OAUTH_STATE_TABLE_NAME;
    const googleAppSecretArn = process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
    const sessionSecretArn = process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN;
    const availabilityLinkSecretArn = process.env.AVAILABILITY_LINK_SECRET_ARN;
    const availabilityLinkTableName = process.env.AVAILABILITY_LINK_TABLE_NAME;
    const googleOauthSecretArn = process.env.GOOGLE_OAUTH_SECRET_ARN;
    const policyPresetsTableName = process.env.POLICY_PRESETS_TABLE_NAME;
    const calendarMode = (process.env.CALENDAR_MODE ?? "connection").toLowerCase();
    const hostTimezone = normalizeTimezone(process.env.HOST_TIMEZONE, "America/Los_Angeles");
    const advisingDays = parseAdvisingDays(process.env.ADVISING_DAYS ?? "Tue,Wed");
    const basePolicyPresets = parseClientPolicyPresets(process.env.CLIENT_POLICY_PRESETS_JSON, advisingDays);
    const workdayStartHour = parseClampedIntEnv(process.env.WORKDAY_START_HOUR, 9, 0, 23);
    const workdayEndHour = parseClampedIntEnv(process.env.WORKDAY_END_HOUR, 17, 1, 24);
    const normalizedWorkdayEndHour = Math.min(24, Math.max(workdayEndHour, workdayStartHour + 1));
    const defaultDurationMinutes = parseClampedIntEnv(process.env.DEFAULT_DURATION_MINUTES, 30, 15, 180);
    const maxDurationMinutes = parseClampedIntEnv(process.env.MAX_DURATION_MINUTES, 120, 15, 240);
    const availabilityViewMaxSlots = parseClampedIntEnv(process.env.AVAILABILITY_VIEW_MAX_SLOTS, 240, 24, 1200);

    const authFailure = await authorizePortalRequest({ event, rawPath, deps });
    if (authFailure) {
      return authFailure;
    }

    let customPolicyRecords = [];
    if (policyPresetsTableName && typeof deps.listPolicyPresets === "function") {
      try {
        customPolicyRecords = await deps.listPolicyPresets(policyPresetsTableName, advisorId);
      } catch {
        customPolicyRecords = [];
      }
    }

    const policyCatalog = buildPolicyCatalog({
      basePolicyPresets,
      customPolicyRecords
    });
    const policyPresets = policyCatalog.mergedPresets;

    if (method === "GET" && rawPath === "/availability") {
      const shortToken = String(event.queryStringParameters?.t ?? "").trim();
      const legacyToken = String(event.queryStringParameters?.token ?? "").trim();
      if (!shortToken && !legacyToken) {
        return availabilityErrorPage("Missing availability token.");
      }
      const weekOffset = parseWeekOffset(event.queryStringParameters);
      const clientHint = decodeClientHint(event.queryStringParameters?.for);
      const clientHintReference = normalizeClientReference(event.queryStringParameters?.for);

      let tokenParamName = "token";
      let linkClientDisplayName = clientHint;
      let linkClientReference = clientHintReference;
      let linkClientId = null;
      let linkClientEmail = null;
      let requestedDuration = null;
      let linkExpiresAtMs = Date.now();
      let effectiveToken = legacyToken;

      if (shortToken) {
        tokenParamName = "t";
        effectiveToken = shortToken;

        if (!availabilityLinkTableName) {
          return serverError("AVAILABILITY_LINK_TABLE_NAME is required");
        }

        const linkRecord = await deps.getAvailabilityLink(availabilityLinkTableName, shortToken);
        if (!linkRecord) {
          return availabilityErrorPage("Invalid or expired availability link.");
        }

        const recordExpiresAtMs = Number(linkRecord.expiresAtMs ?? 0);
        if (!Number.isFinite(recordExpiresAtMs) || recordExpiresAtMs <= Date.now()) {
          return availabilityErrorPage("Invalid or expired availability link.");
        }

        if (String(linkRecord.advisorId ?? "") !== advisorId) {
          return availabilityErrorPage("This availability link is not valid for this advisor.");
        }

        linkClientDisplayName = sanitizeClientDisplayName(linkRecord.clientDisplayName) ?? clientHint;
        linkClientReference = normalizeClientReference(linkRecord.clientReference) ?? clientHintReference;
        linkClientId = normalizeClientId(linkRecord.clientId ?? linkRecord.clientEmail ?? "");
        linkClientEmail = String(linkRecord.clientEmail ?? "").trim().toLowerCase();
        requestedDuration = Number(linkRecord.durationMinutes);
        linkExpiresAtMs = recordExpiresAtMs;
      } else {
        if (!availabilityLinkSecretArn) {
          return serverError("AVAILABILITY_LINK_SECRET_ARN is required");
        }

        let linkSecret;
        try {
          linkSecret = parseAvailabilityLinkSecret(await deps.getSecretString(availabilityLinkSecretArn));
        } catch (error) {
          return serverError(error.message);
        }

        const tokenPayload = validateAvailabilityLinkToken(legacyToken, linkSecret.signingKey);
        if (!tokenPayload) {
          return availabilityErrorPage("Invalid or expired availability link.");
        }

        if (tokenPayload.advisorId !== advisorId) {
          return availabilityErrorPage("This availability link is not valid for this advisor.");
        }

        requestedDuration = Number(tokenPayload.durationMinutes);
        linkExpiresAtMs = Number(tokenPayload.expiresAtMs);
      }

      let effectiveAdvisingDays = advisingDays;
      if (clientProfilesTableName && linkClientId && typeof deps.getClientProfile === "function") {
        const clientProfile = await deps.getClientProfile(clientProfilesTableName, advisorId, linkClientId);
        if (isClientAccessRestricted(clientProfile)) {
          return availabilityErrorPage("This client no longer has access to advisor availability.");
        }

        effectiveAdvisingDays = resolveClientAdvisingDays({
          clientProfile,
          defaultAdvisingDays: advisingDays,
          policyPresets
        });
      }

      const durationMinutes = Number.isFinite(requestedDuration)
        ? Math.min(Math.max(requestedDuration, 15), maxDurationMinutes)
        : defaultDurationMinutes;
      const nowMs = Date.now();
      const baseWeekStartLocal = DateTime.fromMillis(nowMs, { zone: hostTimezone }).startOf("week");
      const searchStartLocal = baseWeekStartLocal.plus({ weeks: weekOffset });
      const searchEndLocal = searchStartLocal.plus({ days: AVAILABILITY_VIEW_DAYS });
      const searchStartIso = searchStartLocal.toUTC().toISO();
      const searchEndIso = searchEndLocal.toUTC().toISO();
      const windowEndLabelLocal = searchEndLocal.minus({ days: 1 });
      const windowLabel = `${searchStartLocal.toFormat("MMM dd, yyyy")} - ${windowEndLabelLocal.toFormat(
        "MMM dd, yyyy"
      )}`;

      const normalizedLinkClientEmail = String(linkClientEmail || "").trim().toLowerCase();
      let availabilityContext;
      try {
        availabilityContext = await lookupAvailabilityContext({
          deps,
          calendarMode,
          connectionsTableName,
          advisorId,
          googleOauthSecretArn,
          searchStartIso,
          searchEndIso,
          clientEmail: normalizedLinkClientEmail
        });
      } catch (error) {
        return serverError(`availability lookup failed: ${error.message}`);
      }

      const calendarModel = buildAvailabilityCalendarModel({
        busyIntervalsUtc: availabilityContext.busyIntervals,
        clientMeetingsUtc: availabilityContext.clientMeetings,
        nonClientBusyIntervalsUtc: availabilityContext.nonClientBusyIntervals,
        hostTimezone,
        advisingDays: effectiveAdvisingDays,
        searchStartIso,
        searchEndIso,
        workdayStartHour,
        workdayEndHour: normalizedWorkdayEndHour,
        slotMinutes: durationMinutes,
        maxCells: availabilityViewMaxSlots
      });

      if (
        clientProfilesTableName &&
        linkClientId &&
        typeof deps.recordClientAvailabilityViewInteraction === "function"
      ) {
        try {
          await deps.recordClientAvailabilityViewInteraction(clientProfilesTableName, {
            advisorId,
            clientId: linkClientId,
            clientEmail: linkClientEmail,
            clientDisplayName: linkClientDisplayName,
            accessState: "active",
            policyId: "default",
            updatedAt: new Date().toISOString()
          });
        } catch {
          // Best-effort client web usage tracking.
        }
      }

      return htmlResponse(
        200,
        buildAvailabilityPage({
          calendarModel,
          hostTimezone,
          expiresAtMs: linkExpiresAtMs,
          tokenParamName,
          token: effectiveToken,
          weekOffset,
          windowLabel,
          clientDisplayName: linkClientDisplayName,
          clientReference: linkClientReference
        })
      );
    }

    if (method === "GET" && rawPath === "/advisor/auth/google/start") {
      if (!oauthStateTableName) {
        return serverError("OAUTH_STATE_TABLE_NAME is required");
      }

      if (!googleAppSecretArn) {
        return serverError("GOOGLE_OAUTH_APP_SECRET_ARN is required");
      }

      let appSecret;
      try {
        appSecret = parseGoogleAppSecret(await deps.getSecretString(googleAppSecretArn));
      } catch (error) {
        return serverError(error.message);
      }

      const returnTo = parseReturnTo(event.queryStringParameters);
      const state = crypto.randomUUID();
      const nowMs = Date.now();
      await deps.putOauthState(oauthStateTableName, state, {
        advisorId,
        purpose: "portal_login",
        returnTo,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: Math.floor((nowMs + 15 * 60 * 1000) / 1000)
      });

      const redirectUri = `${getBaseUrl(event)}/advisor/auth/google/callback`;
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", appSecret.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid email profile");
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("state", state);

      return redirectResponse(authUrl.toString());
    }

    if (method === "GET" && rawPath === "/advisor/auth/google/callback") {
      if (!oauthStateTableName) {
        return serverError("OAUTH_STATE_TABLE_NAME is required");
      }

      if (!googleAppSecretArn) {
        return serverError("GOOGLE_OAUTH_APP_SECRET_ARN is required");
      }

      if (!sessionSecretArn) {
        return serverError("ADVISOR_PORTAL_SESSION_SECRET_ARN is required");
      }

      const code = event.queryStringParameters?.code;
      const state = event.queryStringParameters?.state;
      if (!code || !state) {
        return badRequest("Missing OAuth callback code/state");
      }

      const stateItem = await deps.getOauthState(oauthStateTableName, state);
      if (!stateItem || stateItem.advisorId !== advisorId || stateItem.purpose !== "portal_login") {
        return badRequest("Invalid or expired OAuth state");
      }

      await deps.deleteOauthState(oauthStateTableName, state);

      let appSecret;
      try {
        appSecret = parseGoogleAppSecret(await deps.getSecretString(googleAppSecretArn));
      } catch (error) {
        return serverError(error.message);
      }

      const redirectUri = `${getBaseUrl(event)}/advisor/auth/google/callback`;
      const tokenPayload = await exchangeCodeForTokens({
        clientId: appSecret.clientId,
        clientSecret: appSecret.clientSecret,
        code,
        redirectUri,
        fetchImpl: deps.fetchImpl
      });

      if (!tokenPayload.access_token) {
        return serverError("Google login did not return access_token");
      }

      const profile = await fetchGoogleUserProfile(tokenPayload.access_token, deps.fetchImpl);
      if (!isAuthorizedAdvisorEmail(profile.email)) {
        return advisorAuthErrorPage("The signed-in Google account is not authorized for this advisor portal.");
      }

      let sessionSecret;
      try {
        sessionSecret = await getPortalSessionSecret(deps, sessionSecretArn);
      } catch (error) {
        return serverError(error.message);
      }

      const nowMs = Date.now();
      const sessionToken = createPortalSessionToken(
        {
          email: String(profile.email).trim().toLowerCase(),
          expiresAtMs: nowMs + 12 * 60 * 60 * 1000
        },
        sessionSecret.signingKey
      );

      const returnTo = parseReturnTo({ returnTo: stateItem.returnTo });
      const location = `${getBaseUrl(event)}${returnTo}`;
      return {
        statusCode: 302,
        headers: {
          location,
          "cache-control": "no-store"
        },
        cookies: [buildSessionCookie(sessionToken, 12 * 60 * 60)],
        body: ""
      };
    }

    if (method === "POST" && rawPath === "/advisor/logout") {
      return {
        statusCode: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store"
        },
        cookies: [buildClearSessionCookie()],
        body: JSON.stringify({ loggedOut: true })
      };
    }

    if (method === "GET" && rawPath === "/advisor") {
      return htmlResponse(200, buildAdvisorPage());
    }

    if (method === "GET" && rawPath === "/advisor/api/connections") {
      if (!connectionsTableName) {
        return serverError("CONNECTIONS_TABLE_NAME is required");
      }

      const connections = await deps.listConnections(connectionsTableName, advisorId);
      connections.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));

      return jsonResponse(200, {
        advisorId,
        connections: connections.map((item) => ({
          connectionId: item.connectionId,
          provider: item.provider,
          accountEmail: item.accountEmail,
          status: item.status,
          isPrimary: Boolean(item.isPrimary),
          updatedAt: item.updatedAt
        }))
      });
    }

    if (method === "GET" && rawPath === "/advisor/api/policies") {
      return jsonResponse(200, {
        advisorId,
        policyOptions: policyCatalog.policyOptions,
        policies: policyCatalog.policies
      });
    }

    if (method === "POST" && rawPath === "/advisor/api/policies") {
      if (!policyPresetsTableName) {
        return serverError("POLICY_PRESETS_TABLE_NAME is required");
      }

      let body;
      try {
        body = parseBody(event);
      } catch {
        return badRequest("Request body must be valid JSON");
      }

      const policyId = normalizePolicyId(body.policyId);
      if (!policyId) {
        return badRequest("policyId must match [a-z0-9_-] and be <= 32 chars");
      }

      if (Object.prototype.hasOwnProperty.call(policyPresets, policyId)) {
        return badRequest(`policyId already exists: ${policyId}`);
      }

      let advisingDays;
      try {
        advisingDays = parsePolicyAdvisingDays(body.advisingDays);
      } catch (error) {
        return badRequest(error.message);
      }

      const nowIso = new Date().toISOString();
      await deps.putPolicyPreset(policyPresetsTableName, {
        advisorId,
        policyId,
        advisingDays,
        createdAt: nowIso,
        updatedAt: nowIso
      });

      return jsonResponse(201, {
        advisorId,
        policy: {
          policyId,
          advisingDays,
          source: "custom",
          canDelete: true,
          createdAt: nowIso,
          updatedAt: nowIso
        }
      });
    }

    const policyPresetPathValue = parsePolicyPresetPath(rawPath);
    if (policyPresetPathValue && (method === "PATCH" || method === "DELETE")) {
      if (!policyPresetsTableName) {
        return serverError("POLICY_PRESETS_TABLE_NAME is required");
      }

      const normalizedPolicyId = normalizePolicyId(decodeURIComponent(policyPresetPathValue));
      if (!normalizedPolicyId) {
        return badRequest("Invalid policyId");
      }

      if (!policyCatalog.customPolicyIds.has(normalizedPolicyId)) {
        return badRequest("Only custom policies can be modified via this endpoint");
      }

      if (method === "PATCH") {
        let body;
        try {
          body = parseBody(event);
        } catch {
          return badRequest("Request body must be valid JSON");
        }

        if (!Object.prototype.hasOwnProperty.call(body, "advisingDays")) {
          return badRequest("advisingDays is required");
        }

        let advisingDays;
        try {
          advisingDays = parsePolicyAdvisingDays(body.advisingDays);
        } catch (error) {
          return badRequest(error.message);
        }

        const existingPolicy = customPolicyRecords.find((item) => normalizePolicyId(item.policyId) === normalizedPolicyId);
        const nowIso = new Date().toISOString();
        await deps.putPolicyPreset(policyPresetsTableName, {
          advisorId,
          policyId: normalizedPolicyId,
          advisingDays,
          createdAt: existingPolicy?.createdAt ?? nowIso,
          updatedAt: nowIso
        });

        return jsonResponse(200, {
          advisorId,
          policy: {
            policyId: normalizedPolicyId,
            advisingDays,
            source: "custom",
            canDelete: true,
            createdAt: existingPolicy?.createdAt ?? nowIso,
            updatedAt: nowIso
          }
        });
      }

      if (clientProfilesTableName && typeof deps.listClientProfiles === "function") {
        const clientProfiles = await deps.listClientProfiles(clientProfilesTableName, advisorId);
        const assignedCount = clientProfiles.filter(
          (item) => normalizePolicyId(item.policyId) === normalizedPolicyId
        ).length;
        if (assignedCount > 0) {
          return badRequest(`policyId is assigned to ${assignedCount} clients; reassign them first`);
        }
      }

      await deps.deletePolicyPreset(policyPresetsTableName, advisorId, normalizedPolicyId);
      return jsonResponse(200, {
        advisorId,
        policyId: normalizedPolicyId,
        deleted: true
      });
    }

    if (method === "GET" && rawPath === "/advisor/api/clients") {
      if (!clientProfilesTableName) {
        return serverError("CLIENT_PROFILES_TABLE_NAME is required");
      }

      const clientProfiles = await deps.listClientProfiles(clientProfilesTableName, advisorId);
      clientProfiles.sort((left, right) => {
        const leftLast = String(left.lastInteractionAt ?? "");
        const rightLast = String(right.lastInteractionAt ?? "");
        return rightLast.localeCompare(leftLast);
      });

      return jsonResponse(200, {
        advisorId,
        policyOptions: policyCatalog.policyOptions,
        policies: policyCatalog.policies,
        clients: clientProfiles.map((item) => normalizeClientProfileForApi(item))
      });
    }

    const clientProfilePathValue = parseClientProfilePath(rawPath);
    if (method === "PATCH" && clientProfilePathValue) {
      if (!clientProfilesTableName) {
        return serverError("CLIENT_PROFILES_TABLE_NAME is required");
      }

      const decodedClientId = decodeURIComponent(clientProfilePathValue);
      const clientId = normalizeClientId(decodedClientId);
      if (!clientId || clientId.length > 254) {
        return badRequest("Invalid clientId");
      }

      let body;
      try {
        body = parseBody(event);
      } catch {
        return badRequest("Request body must be valid JSON");
      }

      const existing = await deps.getClientProfile(clientProfilesTableName, advisorId, clientId);
      if (!existing) {
        return jsonResponse(404, { error: "Client not found" });
      }

      const nowIso = new Date().toISOString();
      const merged = {
        ...existing,
        advisorId,
        clientId,
        updatedAt: nowIso
      };

      if (body.accessState !== undefined) {
        const normalizedAccessState = String(body.accessState ?? "")
          .trim()
          .toLowerCase();
        if (!["active", "blocked", "deleted"].includes(normalizedAccessState)) {
          return badRequest("accessState must be one of: active, blocked, deleted");
        }

        merged.accessState = normalizedAccessState;
      }

      if (body.policyId !== undefined) {
        const normalizedPolicyId = normalizePolicyId(body.policyId);
        if (!normalizedPolicyId || !Object.prototype.hasOwnProperty.call(policyPresets, normalizedPolicyId)) {
          return badRequest(`policyId must be one of: ${policyCatalog.policyOptions.join(", ")}`);
        }

        merged.policyId = normalizedPolicyId;
      }

      if (Object.prototype.hasOwnProperty.call(body, "advisingDaysOverride")) {
        if (
          body.advisingDaysOverride === null ||
          body.advisingDaysOverride === "" ||
          (Array.isArray(body.advisingDaysOverride) && body.advisingDaysOverride.length === 0)
        ) {
          delete merged.advisingDaysOverride;
        } else {
          try {
            merged.advisingDaysOverride = parseClientAdvisingDaysOverride(body.advisingDaysOverride);
          } catch (error) {
            return badRequest(error.message);
          }
        }
      }

      if (body.clientDisplayName !== undefined) {
        merged.clientDisplayName = sanitizeClientDisplayName(body.clientDisplayName) ?? merged.clientDisplayName;
      }

      await deps.putClientProfile(clientProfilesTableName, merged);

      return jsonResponse(200, {
        advisorId,
        client: normalizeClientProfileForApi(merged)
      });
    }

    const traceLookupRequestId = parseTraceLookupPath(rawPath);
    if (method === "GET" && traceLookupRequestId) {
      if (!traceTableName) {
        return serverError("TRACE_TABLE_NAME is required");
      }

      if (!isValidRequestId(traceLookupRequestId)) {
        return badRequest("Invalid requestId format");
      }

      const trace = await deps.getTrace(traceTableName, traceLookupRequestId);
      if (!trace || (trace.advisorId && trace.advisorId !== advisorId)) {
        return jsonResponse(404, { error: "Trace not found" });
      }

      const metadata = selectTraceMetadata(trace);
      return jsonResponse(200, {
        trace: metadata,
        diagnosis: buildTraceDiagnosis(metadata)
      });
    }

    const traceFeedbackRequestId = parseTraceFeedbackPath(rawPath);
    if (method === "POST" && traceFeedbackRequestId) {
      if (!traceTableName) {
        return serverError("TRACE_TABLE_NAME is required");
      }

      if (!isValidRequestId(traceFeedbackRequestId)) {
        return badRequest("Invalid requestId format");
      }

      let body;
      try {
        body = parseBody(event);
      } catch {
        return badRequest("Request body must be valid JSON");
      }

      let feedback;
      try {
        feedback = parseFeedbackPayload(
          {
            ...body,
            requestId: traceFeedbackRequestId,
            feedbackSource: "advisor"
          },
          "advisor"
        );
      } catch (error) {
        return badRequest(error.message);
      }

      const updatedAt = new Date().toISOString();
      const updated = await deps.updateTraceFeedback(traceTableName, {
        requestId: feedback.requestId,
        responseId: feedback.responseId,
        feedbackSource: feedback.feedbackSource,
        feedbackType: feedback.feedbackType,
        feedbackReason: feedback.feedbackReason,
        updatedAt
      });

      if (!updated || (updated.advisorId && updated.advisorId !== advisorId)) {
        return jsonResponse(404, { error: "Trace not found" });
      }

      return jsonResponse(200, {
        requestId: feedback.requestId,
        responseId: feedback.responseId,
        feedbackRecorded: true,
        feedbackSource: feedback.feedbackSource,
        feedbackType: feedback.feedbackType,
        feedbackReason: feedback.feedbackReason,
        feedbackUpdatedAt: updatedAt
      });
    }

    if (method === "POST" && rawPath === "/advisor/api/connections/mock") {
      if (!connectionsTableName) {
        return serverError("CONNECTIONS_TABLE_NAME is required");
      }

      const nowIso = new Date().toISOString();
      const connectionId = `mock-${crypto.randomUUID()}`;

      await deps.putConnection(connectionsTableName, {
        advisorId,
        connectionId,
        provider: "mock",
        accountEmail: "mock@local",
        status: "connected",
        isPrimary: true,
        createdAt: nowIso,
        updatedAt: nowIso
      });

      return jsonResponse(201, {
        connectionId,
        provider: "mock",
        status: "connected"
      });
    }

    if ((method === "POST" || method === "GET") && rawPath === "/advisor/api/connections/google/start") {
      if (!oauthStateTableName) {
        if (method === "GET") {
          return redirectAdvisorWithError(event, "OAUTH_STATE_TABLE_NAME is required");
        }

        return serverError("OAUTH_STATE_TABLE_NAME is required");
      }

      const googleAppSecretArn = process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
      if (!googleAppSecretArn) {
        if (method === "GET") {
          return redirectAdvisorWithError(event, "Google OAuth app is not configured in this environment yet.");
        }

        return badRequest("Google OAuth app is not configured in this environment yet.");
      }

      let appSecret;
      try {
        appSecret = parseGoogleAppSecret(await deps.getSecretString(googleAppSecretArn));
      } catch (error) {
        if (method === "GET") {
          return redirectAdvisorWithError(event, error.message);
        }

        return badRequest(error.message);
      }

      const state = crypto.randomUUID();
      const nowMs = Date.now();

      await deps.putOauthState(oauthStateTableName, state, {
        advisorId,
        purpose: "calendar_connection",
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: Math.floor((nowMs + 15 * 60 * 1000) / 1000)
      });

      const redirectUri = `${getBaseUrl(event)}/advisor/api/connections/google/callback`;
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", appSecret.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.readonly openid email profile");
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("state", state);

      return redirectResponse(authUrl.toString());
    }

    if (method === "GET" && rawPath === "/advisor/api/connections/google/callback") {
      if (!oauthStateTableName) {
        return serverError("OAUTH_STATE_TABLE_NAME is required");
      }

      if (!connectionsTableName) {
        return serverError("CONNECTIONS_TABLE_NAME is required");
      }

      const code = event.queryStringParameters?.code;
      const state = event.queryStringParameters?.state;
      if (!code || !state) {
        return badRequest("Missing OAuth callback code/state");
      }

      const stateItem = await deps.getOauthState(oauthStateTableName, state);
      if (!stateItem || stateItem.advisorId !== advisorId || stateItem.purpose !== "calendar_connection") {
        return badRequest("Invalid or expired OAuth state");
      }

      await deps.deleteOauthState(oauthStateTableName, state);

      const googleAppSecretArn = process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
      if (!googleAppSecretArn) {
        return badRequest("Google OAuth app is not configured in this environment yet.");
      }

      let appSecret;
      try {
        appSecret = parseGoogleAppSecret(await deps.getSecretString(googleAppSecretArn));
      } catch (error) {
        return badRequest(error.message);
      }

      const redirectUri = `${getBaseUrl(event)}/advisor/api/connections/google/callback`;

      const tokenPayload = await exchangeCodeForTokens({
        clientId: appSecret.clientId,
        clientSecret: appSecret.clientSecret,
        code,
        redirectUri,
        fetchImpl: deps.fetchImpl
      });

      if (!tokenPayload.refresh_token) {
        return badRequest("Google did not return refresh_token. Reconnect and ensure consent prompt is granted.");
      }

      const profile = tokenPayload.access_token
        ? await fetchGoogleUserProfile(tokenPayload.access_token, deps.fetchImpl)
        : { email: null };

      const nowIso = new Date().toISOString();
      const connectionId = `google-${crypto.randomUUID()}`;
      const secretName = `/${appName}/${stage}/${advisorId}/connections/${connectionId}`;
      const secretArn = await deps.createSecret(
        secretName,
        JSON.stringify({
          client_id: appSecret.clientId,
          client_secret: appSecret.clientSecret,
          refresh_token: tokenPayload.refresh_token,
          calendar_ids: ["primary"]
        })
      );

      await deps.putConnection(connectionsTableName, {
        advisorId,
        connectionId,
        provider: "google",
        accountEmail: profile.email ?? "unknown@google",
        status: "connected",
        isPrimary: true,
        secretArn,
        createdAt: nowIso,
        updatedAt: nowIso
      });

      return redirectResponse(`${getBaseUrl(event)}/advisor?connected=google`);
    }

    if (method === "DELETE" && rawPath.startsWith("/advisor/api/connections/")) {
      if (!connectionsTableName) {
        return serverError("CONNECTIONS_TABLE_NAME is required");
      }

      const connectionId = rawPath.split("/").at(-1);
      if (!connectionId) {
        return badRequest("Missing connectionId");
      }

      const existing = await deps.getConnection(connectionsTableName, advisorId, connectionId);
      if (!existing) {
        return jsonResponse(404, { error: "Connection not found" });
      }

      if (existing.secretArn) {
        try {
          await deps.deleteSecret(existing.secretArn);
        } catch {
          // Best-effort token cleanup for missing/deleted secrets.
        }
      }

      await deps.deleteConnection(connectionsTableName, advisorId, connectionId);
      return jsonResponse(200, { deleted: true, connectionId });
    }

    return routeNotFound();
  };
}

export const handler = createPortalHandler();
