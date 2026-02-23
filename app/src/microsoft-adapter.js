import { DateTime } from "luxon";

const MAX_CALENDAR_VIEW_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const POPULAR_FREE_EMAIL_DOMAINS = new Set([
  "live.com",
  "gmail.com",
  "mail.google.com",
  "hotmail.com",
  "mail.ru",
  "yahoo.com"
]);

function assertRequired(value, key) {
  if (!value || typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required Microsoft OAuth field: ${key}`);
  }
}

function normalizeTenantId(value) {
  const candidate = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!candidate) {
    return "common";
  }

  if (/^[a-z0-9.-]+$/.test(candidate)) {
    return candidate;
  }

  return "common";
}

function splitBusyWindow(windowStartIso, windowEndIso, maxWindowDays = MAX_CALENDAR_VIEW_WINDOW_DAYS) {
  const startMs = Date.parse(windowStartIso);
  const endMs = Date.parse(windowEndIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return [
      {
        timeMinIso: windowStartIso,
        timeMaxIso: windowEndIso
      }
    ];
  }

  const maxWindowMs = Math.max(1, Math.floor(maxWindowDays)) * DAY_MS;
  const windows = [];
  let cursorMs = startMs;
  while (cursorMs < endMs) {
    const chunkEndMs = Math.min(endMs, cursorMs + maxWindowMs);
    windows.push({
      timeMinIso: new Date(cursorMs).toISOString(),
      timeMaxIso: new Date(chunkEndMs).toISOString()
    });
    cursorMs = chunkEndMs;
  }

  return windows;
}

function normalizeEmail(emailValue) {
  return String(emailValue ?? "")
    .trim()
    .toLowerCase();
}

function extractEmailDomain(emailValue) {
  const normalized = normalizeEmail(emailValue);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0 || atIndex >= normalized.length - 1) {
    return null;
  }

  const domain = normalized.slice(atIndex + 1).replace(/[^a-z0-9.-]/g, "");
  return domain || null;
}

function usesExactEmailOwnershipMatch(clientEmail) {
  const domain = extractEmailDomain(clientEmail);
  return domain ? POPULAR_FREE_EMAIL_DOMAINS.has(domain) : false;
}

function normalizeMeetingTitle(subject) {
  const value = String(subject ?? "").trim();
  return value.length > 0 ? value : "Client meeting";
}

function normalizeAdvisorResponseStatus(rawStatus) {
  const normalized = String(rawStatus ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "accepted" || normalized === "organizer") {
    return "accepted";
  }
  return "pending";
}

function deriveAdvisorResponseStatus(event, advisorEmailHint) {
  const selfStatus = event?.responseStatus?.response;
  if (selfStatus) {
    return normalizeAdvisorResponseStatus(selfStatus);
  }

  const normalizedAdvisorEmail = normalizeEmail(advisorEmailHint);
  const attendees = Array.isArray(event?.attendees) ? event.attendees : [];
  if (normalizedAdvisorEmail) {
    const advisorAttendee = attendees.find(
      (attendee) =>
        normalizeEmail(attendee?.emailAddress?.address) === normalizedAdvisorEmail
    );
    if (advisorAttendee?.status?.response) {
      return normalizeAdvisorResponseStatus(advisorAttendee.status.response);
    }
  }

  const organizerEmail = normalizeEmail(event?.organizer?.emailAddress?.address);
  if (normalizedAdvisorEmail && organizerEmail && organizerEmail === normalizedAdvisorEmail) {
    return "accepted";
  }

  return "pending";
}

function parseGraphDateTime(dateTimePayload) {
  if (!dateTimePayload || typeof dateTimePayload !== "object") {
    return null;
  }

  const dateTimeValue = String(dateTimePayload.dateTime ?? "").trim();
  if (!dateTimeValue) {
    return null;
  }

  const graphZone = String(dateTimePayload.timeZone ?? "UTC").trim() || "UTC";
  const parsed = DateTime.fromISO(dateTimeValue, { zone: graphZone });
  if (parsed.isValid) {
    return parsed.toUTC().toISO();
  }

  const fallbackParsed = Date.parse(dateTimeValue);
  if (Number.isFinite(fallbackParsed)) {
    return new Date(fallbackParsed).toISOString();
  }

  return null;
}

function isBusyEvent(event) {
  const normalizedShowAs = String(event?.showAs ?? "")
    .trim()
    .toLowerCase();
  if (!normalizedShowAs) {
    return true;
  }

  return normalizedShowAs !== "free";
}

function eventMatchesClientOwnership(event, { clientEmail, clientDomain, useExactEmailMatch }) {
  if (useExactEmailMatch && !clientEmail) {
    return false;
  }
  if (!useExactEmailMatch && !clientDomain) {
    return false;
  }

  const attendees = Array.isArray(event?.attendees) ? event.attendees : [];
  const participantEmails = attendees
    .map((attendee) => normalizeEmail(attendee?.emailAddress?.address))
    .filter(Boolean);
  const organizerEmail = normalizeEmail(event?.organizer?.emailAddress?.address);
  if (organizerEmail) {
    participantEmails.push(organizerEmail);
  }

  if (useExactEmailMatch) {
    return participantEmails.includes(clientEmail);
  }

  return participantEmails.some((emailValue) => extractEmailDomain(emailValue) === clientDomain);
}

function buildCalendarViewUrl({ calendarId, timeMinIso, timeMaxIso }) {
  const baseUrl =
    calendarId === "primary"
      ? "https://graph.microsoft.com/v1.0/me/calendarView"
      : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView`;
  const url = new URL(baseUrl);
  url.searchParams.set("startDateTime", timeMinIso);
  url.searchParams.set("endDateTime", timeMaxIso);
  url.searchParams.set("$top", "1000");
  url.searchParams.set(
    "$select",
    "id,subject,start,end,showAs,isCancelled,responseStatus,attendees,status,organizer"
  );
  return url.toString();
}

async function fetchCalendarViewEvents({
  accessToken,
  calendarId,
  timeMinIso,
  timeMaxIso,
  fetchImpl
}) {
  const fetchFn = fetchImpl ?? fetch;
  const events = [];
  let nextUrl = buildCalendarViewUrl({
    calendarId,
    timeMinIso,
    timeMaxIso
  });

  while (nextUrl) {
    const response = await fetchFn(nextUrl, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Microsoft calendarView request failed (${response.status}): ${message}`);
    }

    const payload = await response.json();
    const pageEvents = Array.isArray(payload.value) ? payload.value : [];
    events.push(...pageEvents);
    nextUrl = typeof payload["@odata.nextLink"] === "string" ? payload["@odata.nextLink"] : null;
  }

  return events;
}

function buildTokenEndpoint(tenantId) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

export function parseMicrosoftOauthSecret(secretString) {
  if (!secretString || typeof secretString !== "string") {
    throw new Error("Microsoft OAuth secret is empty");
  }

  const parsed = JSON.parse(secretString);
  assertRequired(parsed.client_id, "client_id");
  assertRequired(parsed.client_secret, "client_secret");
  assertRequired(parsed.refresh_token, "refresh_token");

  const calendarIds = Array.isArray(parsed.calendar_ids)
    ? parsed.calendar_ids.filter((item) => typeof item === "string" && item.trim().length > 0)
    : ["primary"];

  return {
    clientId: parsed.client_id,
    clientSecret: parsed.client_secret,
    refreshToken: parsed.refresh_token,
    tenantId: normalizeTenantId(parsed.tenant_id),
    calendarIds: calendarIds.length > 0 ? calendarIds : ["primary"]
  };
}

export async function exchangeRefreshToken({
  clientId,
  clientSecret,
  refreshToken,
  tenantId = "common",
  fetchImpl
}) {
  const fetchFn = fetchImpl ?? fetch;
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: "openid profile email offline_access User.Read Calendars.Read"
  });

  const response = await fetchFn(buildTokenEndpoint(tenantId), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Microsoft token exchange failed (${response.status}): ${message}`);
  }

  const payload = await response.json();
  if (!payload.access_token || typeof payload.access_token !== "string") {
    throw new Error("Microsoft token exchange response missing access_token");
  }

  return payload.access_token;
}

export async function lookupMicrosoftBusyIntervals({
  oauthConfig,
  windowStartIso,
  windowEndIso,
  fetchImpl
}) {
  const accessToken = await exchangeRefreshToken({
    clientId: oauthConfig.clientId,
    clientSecret: oauthConfig.clientSecret,
    refreshToken: oauthConfig.refreshToken,
    tenantId: oauthConfig.tenantId,
    fetchImpl
  });

  const intervals = [];
  const dedup = new Set();
  const windows = splitBusyWindow(windowStartIso, windowEndIso);

  for (const window of windows) {
    for (const calendarId of oauthConfig.calendarIds) {
      const events = await fetchCalendarViewEvents({
        accessToken,
        calendarId,
        timeMinIso: window.timeMinIso,
        timeMaxIso: window.timeMaxIso,
        fetchImpl
      });

      for (const event of events) {
        if (!event || event.isCancelled === true || !isBusyEvent(event)) {
          continue;
        }

        const startIso = parseGraphDateTime(event.start);
        const endIso = parseGraphDateTime(event.end);
        if (!startIso || !endIso || Date.parse(endIso) <= Date.parse(startIso)) {
          continue;
        }

        const key = `${startIso}|${endIso}|${calendarId}`;
        if (dedup.has(key)) {
          continue;
        }
        dedup.add(key);
        intervals.push({
          startIso,
          endIso,
          calendarId
        });
      }
    }
  }

  intervals.sort((left, right) => Date.parse(left.startIso) - Date.parse(right.startIso));
  return intervals;
}

export async function lookupMicrosoftClientMeetings({
  oauthConfig,
  windowStartIso,
  windowEndIso,
  clientEmail,
  advisorEmailHint,
  fetchImpl
}) {
  const normalizedClientEmail = normalizeEmail(clientEmail);
  const normalizedClientDomain = extractEmailDomain(normalizedClientEmail);
  if (!normalizedClientEmail || !normalizedClientDomain) {
    return {
      clientMeetings: [],
      nonClientBusyIntervals: []
    };
  }

  const useExactEmailMatch = usesExactEmailOwnershipMatch(normalizedClientEmail);
  const accessToken = await exchangeRefreshToken({
    clientId: oauthConfig.clientId,
    clientSecret: oauthConfig.clientSecret,
    refreshToken: oauthConfig.refreshToken,
    tenantId: oauthConfig.tenantId,
    fetchImpl
  });

  const windows = splitBusyWindow(windowStartIso, windowEndIso);
  const meetingDedup = new Map();
  const nonClientBusyDedup = new Set();
  const nonClientBusyIntervals = [];

  for (const window of windows) {
    for (const calendarId of oauthConfig.calendarIds) {
      const events = await fetchCalendarViewEvents({
        accessToken,
        calendarId,
        timeMinIso: window.timeMinIso,
        timeMaxIso: window.timeMaxIso,
        fetchImpl
      });

      for (const event of events) {
        if (!event || event.isCancelled === true || !isBusyEvent(event)) {
          continue;
        }

        const startIso = parseGraphDateTime(event.start);
        const endIso = parseGraphDateTime(event.end);
        if (!startIso || !endIso || Date.parse(endIso) <= Date.parse(startIso)) {
          continue;
        }

        if (
          eventMatchesClientOwnership(event, {
            clientEmail: normalizedClientEmail,
            clientDomain: normalizedClientDomain,
            useExactEmailMatch
          })
        ) {
          const meeting = {
            eventId: String(event.id ?? ""),
            calendarId,
            startIso,
            endIso,
            title: normalizeMeetingTitle(event.subject),
            advisorResponseStatus: deriveAdvisorResponseStatus(event, advisorEmailHint)
          };
          const meetingKey = `${meeting.eventId}|${meeting.startIso}|${meeting.endIso}|${meeting.calendarId}`;
          if (!meetingDedup.has(meetingKey)) {
            meetingDedup.set(meetingKey, meeting);
          }
        } else {
          const busyKey = `${startIso}|${endIso}|${calendarId}`;
          if (nonClientBusyDedup.has(busyKey)) {
            continue;
          }
          nonClientBusyDedup.add(busyKey);
          nonClientBusyIntervals.push({
            startIso,
            endIso,
            calendarId
          });
        }
      }
    }
  }

  const clientMeetings = Array.from(meetingDedup.values());
  clientMeetings.sort((left, right) => Date.parse(left.startIso) - Date.parse(right.startIso));
  nonClientBusyIntervals.sort((left, right) => Date.parse(left.startIso) - Date.parse(right.startIso));

  return {
    clientMeetings,
    nonClientBusyIntervals
  };
}
