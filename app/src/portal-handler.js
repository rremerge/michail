import crypto from "node:crypto";
import { createRuntimeDeps } from "./runtime-deps.js";

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

      document.getElementById('addMock').addEventListener('click', async () => {
        await fetch('./advisor/api/connections/mock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
        await loadConnections();
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
    ...overrides
  };

  return async function handler(event) {
    const method = event.requestContext?.http?.method ?? "GET";
    const rawPath = normalizeRawPath(event.rawPath ?? "/", event.requestContext?.stage);

    const advisorId = process.env.ADVISOR_ID ?? "manoj";
    const appName = process.env.APP_NAME ?? "calendar-agent-spike";
    const stage = process.env.STAGE ?? "dev";
    const connectionsTableName = process.env.CONNECTIONS_TABLE_NAME;
    const traceTableName = process.env.TRACE_TABLE_NAME;
    const oauthStateTableName = process.env.OAUTH_STATE_TABLE_NAME;
    const googleAppSecretArn = process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
    const sessionSecretArn = process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN;

    const authFailure = await authorizePortalRequest({ event, rawPath, deps });
    if (authFailure) {
      return authFailure;
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
