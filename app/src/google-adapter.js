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
