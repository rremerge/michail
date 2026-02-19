function assertRequired(value, key) {
  if (!value || typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required Google OAuth field: ${key}`);
  }
}

const MAX_FREEBUSY_WINDOW_DAYS = 85;
const DAY_MS = 24 * 60 * 60 * 1000;

function splitBusyWindow(windowStartIso, windowEndIso, maxWindowDays = MAX_FREEBUSY_WINDOW_DAYS) {
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

export function parseGoogleOauthSecret(secretString) {
  if (!secretString || typeof secretString !== "string") {
    throw new Error("Google OAuth secret is empty");
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
    calendarIds: calendarIds.length > 0 ? calendarIds : ["primary"]
  };
}

export async function exchangeRefreshToken({ clientId, clientSecret, refreshToken, fetchImpl }) {
  const fetchFn = fetchImpl ?? fetch;
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
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
    throw new Error(`Google token exchange failed (${response.status}): ${message}`);
  }

  const payload = await response.json();
  if (!payload.access_token || typeof payload.access_token !== "string") {
    throw new Error("Google token exchange response missing access_token");
  }

  return payload.access_token;
}

export async function fetchBusyIntervals({
  accessToken,
  calendarIds,
  timeMinIso,
  timeMaxIso,
  fetchImpl
}) {
  const fetchFn = fetchImpl ?? fetch;

  const response = await fetchFn("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      items: calendarIds.map((id) => ({ id }))
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Google freeBusy request failed (${response.status}): ${message}`);
  }

  const payload = await response.json();
  const calendars = payload.calendars ?? {};
  const intervals = [];

  for (const calendarId of Object.keys(calendars)) {
    const busyEntries = calendars[calendarId]?.busy ?? [];
    for (const busyEntry of busyEntries) {
      if (!busyEntry.start || !busyEntry.end) {
        continue;
      }

      intervals.push({
        startIso: busyEntry.start,
        endIso: busyEntry.end,
        calendarId
      });
    }
  }

  intervals.sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso));
  return intervals;
}

function normalizeEventDateTime(eventTime) {
  if (!eventTime || typeof eventTime !== "object") {
    return null;
  }

  const dateTimeValue = String(eventTime.dateTime ?? "").trim();
  if (dateTimeValue) {
    const parsed = Date.parse(dateTimeValue);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  const dateValue = String(eventTime.date ?? "").trim();
  if (dateValue) {
    const parsed = Date.parse(`${dateValue}T00:00:00Z`);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return null;
}

function normalizeEmail(emailValue) {
  return String(emailValue ?? "")
    .trim()
    .toLowerCase();
}

const POPULAR_FREE_EMAIL_DOMAINS = new Set([
  "live.com",
  "gmail.com",
  "mail.google.com",
  "hotmail.com",
  "mail.ru",
  "yahoo.com"
]);

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

function normalizeAdvisorResponseStatus(rawStatus) {
  const normalized = String(rawStatus ?? "")
    .trim()
    .toLowerCase();
  return normalized === "accepted" ? "accepted" : "pending";
}

function deriveAdvisorResponseStatus(event, advisorEmailHint) {
  const attendees = Array.isArray(event?.attendees) ? event.attendees : [];
  const selfAttendee = attendees.find((attendee) => attendee?.self === true);
  if (selfAttendee?.responseStatus) {
    return normalizeAdvisorResponseStatus(selfAttendee.responseStatus);
  }

  const normalizedAdvisorEmail = String(advisorEmailHint ?? "")
    .trim()
    .toLowerCase();
  if (normalizedAdvisorEmail) {
    const advisorAttendee = attendees.find(
      (attendee) =>
        String(attendee?.email ?? "")
          .trim()
          .toLowerCase() === normalizedAdvisorEmail
    );
    if (advisorAttendee?.responseStatus) {
      return normalizeAdvisorResponseStatus(advisorAttendee.responseStatus);
    }
  }

  if (event?.organizer?.self === true) {
    return "accepted";
  }

  if (event?.organizer?.responseStatus) {
    return normalizeAdvisorResponseStatus(event.organizer.responseStatus);
  }

  return "pending";
}

function eventMatchesClientOwnership(event, { clientEmail, clientDomain, useExactEmailMatch }) {
  if (useExactEmailMatch && !clientEmail) {
    return false;
  }
  if (!useExactEmailMatch && !clientDomain) {
    return false;
  }

  const attendees = Array.isArray(event?.attendees) ? event.attendees : [];
  if (useExactEmailMatch) {
    if (attendees.some((attendee) => attendee?.self !== true && normalizeEmail(attendee?.email) === clientEmail)) {
      return true;
    }
    return event?.organizer?.self !== true && normalizeEmail(event?.organizer?.email) === clientEmail;
  }

  if (attendees.some((attendee) => attendee?.self !== true && extractEmailDomain(attendee?.email) === clientDomain)) {
    return true;
  }
  return event?.organizer?.self !== true && extractEmailDomain(event?.organizer?.email) === clientDomain;
}

function normalizeMeetingTitle(summary) {
  const value = String(summary ?? "").trim();
  return value.length > 0 ? value : "Client meeting";
}

async function fetchCalendarEvents({
  accessToken,
  calendarId,
  timeMinIso,
  timeMaxIso,
  clientEmail,
  clientDomain,
  useExactEmailMatch,
  advisorEmailHint,
  fetchImpl
}) {
  const fetchFn = fetchImpl ?? fetch;
  const meetings = [];
  const nonClientBusyIntervals = [];
  let pageToken = null;

  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    );
    url.searchParams.set("timeMin", timeMinIso);
    url.searchParams.set("timeMax", timeMaxIso);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("showDeleted", "false");
    url.searchParams.set("maxResults", "2500");
    url.searchParams.set(
      "fields",
      "items(id,summary,start,end,status,transparency,attendees(email,responseStatus,self),organizer(email,self)),nextPageToken"
    );
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetchFn(url.toString(), {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Google events request failed (${response.status}): ${message}`);
    }

    const payload = await response.json();
    const events = Array.isArray(payload.items) ? payload.items : [];
    for (const event of events) {
      if (!event || event.status === "cancelled" || event.transparency === "transparent") {
        continue;
      }

      const startIso = normalizeEventDateTime(event.start);
      const endIso = normalizeEventDateTime(event.end);
      if (!startIso || !endIso || Date.parse(endIso) <= Date.parse(startIso)) {
        continue;
      }

      if (eventMatchesClientOwnership(event, { clientEmail, clientDomain, useExactEmailMatch })) {
        meetings.push({
          eventId: String(event.id ?? ""),
          calendarId,
          startIso,
          endIso,
          title: normalizeMeetingTitle(event.summary),
          advisorResponseStatus: deriveAdvisorResponseStatus(event, advisorEmailHint)
        });
      } else {
        nonClientBusyIntervals.push({
          startIso,
          endIso,
          calendarId
        });
      }
    }

    pageToken = payload.nextPageToken ?? null;
  } while (pageToken);

  return {
    clientMeetings: meetings,
    nonClientBusyIntervals
  };
}

export async function lookupGoogleClientMeetings({
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
    fetchImpl
  });

  const meetingDedup = new Map();
  const nonClientBusyDedup = new Set();
  const nonClientBusyIntervals = [];
  const windows = splitBusyWindow(windowStartIso, windowEndIso);

  for (const window of windows) {
    for (const calendarId of oauthConfig.calendarIds) {
      const overlay = await fetchCalendarEvents({
        accessToken,
        calendarId,
        timeMinIso: window.timeMinIso,
        timeMaxIso: window.timeMaxIso,
        clientEmail: normalizedClientEmail,
        clientDomain: normalizedClientDomain,
        useExactEmailMatch,
        advisorEmailHint,
        fetchImpl
      });

      for (const meeting of overlay.clientMeetings) {
        const key = `${meeting.eventId}|${meeting.startIso}|${meeting.endIso}|${meeting.calendarId}`;
        if (!meetingDedup.has(key)) {
          meetingDedup.set(key, meeting);
        }
      }

      for (const interval of overlay.nonClientBusyIntervals) {
        const key = `${interval.startIso}|${interval.endIso}|${interval.calendarId}`;
        if (nonClientBusyDedup.has(key)) {
          continue;
        }

        nonClientBusyDedup.add(key);
        nonClientBusyIntervals.push(interval);
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

export async function lookupGoogleBusyIntervals({
  oauthConfig,
  windowStartIso,
  windowEndIso,
  fetchImpl
}) {
  const accessToken = await exchangeRefreshToken({
    clientId: oauthConfig.clientId,
    clientSecret: oauthConfig.clientSecret,
    refreshToken: oauthConfig.refreshToken,
    fetchImpl
  });

  const intervals = [];
  const windows = splitBusyWindow(windowStartIso, windowEndIso);
  for (const window of windows) {
    const chunkIntervals = await fetchBusyIntervals({
      accessToken,
      calendarIds: oauthConfig.calendarIds,
      timeMinIso: window.timeMinIso,
      timeMaxIso: window.timeMaxIso,
      fetchImpl
    });
    intervals.push(...chunkIntervals);
  }

  intervals.sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso));
  return intervals;
}
