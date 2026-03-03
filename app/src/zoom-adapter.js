function normalizeZoomSecretValue(secretString) {
  if (!secretString || typeof secretString !== "string") {
    throw new Error("Zoom secret is empty");
  }
  return JSON.parse(secretString);
}

export function parseZoomAppSecret(secretString) {
  const parsed = normalizeZoomSecretValue(secretString);
  const clientId = String(parsed.client_id ?? "").trim();
  const clientSecret = String(parsed.client_secret ?? "").trim();

  if (!clientId || !clientSecret) {
    throw new Error("Zoom OAuth app secret is missing client_id or client_secret");
  }

  return { clientId, clientSecret };
}

export function parseZoomMeetingSecret(secretString) {
  const parsed = normalizeZoomSecretValue(secretString);
  const refreshToken = String(parsed.refresh_token ?? "").trim();
  const accountEmail = String(parsed.account_email ?? "").trim().toLowerCase() || null;

  if (!refreshToken) {
    throw new Error("Zoom meeting secret is missing refresh_token");
  }

  return {
    refreshToken,
    accountEmail
  };
}

function buildZoomBasicAuthHeader(clientId, clientSecret) {
  const raw = `${clientId}:${clientSecret}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

export async function exchangeZoomRefreshToken({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl
}) {
  const fetchFn = fetchImpl ?? fetch;
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const response = await fetchFn("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      authorization: buildZoomBasicAuthHeader(clientId, clientSecret),
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Zoom token refresh failed (${response.status}): ${message}`);
  }

  const payload = await response.json();
  const accessToken = String(payload?.access_token ?? "").trim();
  if (!accessToken) {
    throw new Error("Zoom token refresh response missing access_token");
  }

  return {
    accessToken,
    refreshToken: String(payload?.refresh_token ?? "").trim() || null
  };
}

export async function createZoomMeeting({
  accessToken,
  topic,
  startIsoUtc,
  durationMinutes,
  timezone,
  fetchImpl
}) {
  const fetchFn = fetchImpl ?? fetch;
  const payload = {
    topic: String(topic ?? "").trim() || "Advisory Meeting",
    type: 2,
    start_time: new Date(startIsoUtc).toISOString(),
    duration: Math.max(15, Number.parseInt(durationMinutes ?? "30", 10) || 30),
    timezone: String(timezone ?? "").trim() || "UTC",
    settings: {
      join_before_host: false,
      waiting_room: true
    }
  };

  const response = await fetchFn("https://api.zoom.us/v2/users/me/meetings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Zoom meeting create failed (${response.status}): ${message}`);
  }

  const meeting = await response.json();
  const meetingUrl = String(meeting?.join_url ?? "").trim();
  if (!meetingUrl) {
    throw new Error("Zoom meeting create response missing join_url");
  }

  return {
    meetingUrl,
    meetingId: meeting?.id ?? null
  };
}
