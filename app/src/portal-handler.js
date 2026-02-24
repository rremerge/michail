import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimeDeps } from "./runtime-deps.js";
import { DateTime, Interval } from "luxon";
import {
  parseGoogleOauthSecret,
  lookupGoogleAdvisorMeetings,
  lookupGoogleBusyIntervals,
  lookupGoogleClientMeetings
} from "./google-adapter.js";
import {
  lookupMicrosoftAdvisorMeetings,
  lookupMicrosoftBusyIntervals,
  lookupMicrosoftClientMeetings,
  parseMicrosoftOauthSecret
} from "./microsoft-adapter.js";
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

function parseFloatEnv(value, fallback) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseClampedIntEnv(value, fallback, minimum, maximum) {
  const parsed = parseIntEnv(value, fallback);
  return Math.min(Math.max(parsed, minimum), maximum);
}

function parseBooleanEnv(value, fallback = false) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return fallback;
}

function toNonNegativeInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.trunc(parsed));
}

const AVAILABILITY_VIEW_DAYS = 7;
const DEFAULT_ADVISOR_TIMEZONE = "America/Los_Angeles";
const DEFAULT_AGENT_EMAIL_DOMAIN = "agent.letsconnect.ai";
const DEFAULT_LLM_PROVIDER = "openai";
const DEFAULT_LLM_MODEL = "gpt-5.2";
const DEFAULT_LLM_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const ALLOWED_LLM_PROVIDERS = new Set(["openai"]);
const ALLOWED_LLM_KEY_MODES = new Set(["platform", "advisor"]);
const USAGE_WINDOW_DAYS = {
  daily: 1,
  weekly: 7,
  monthly: 30
};
const DEFAULT_USAGE_WINDOW = "weekly";
const BRAND_STORAGE_KEY = "letsconnect.whitelabel.logo.dataurl";
const BRAND_COPYRIGHT_NOTICE = "Copyright (C) 2026. RR Emerge LLC";
const BRAND_POWERED_BY_NOTICE = "Powered by LetsConnect.ai";
const DEFAULT_BRAND_LOGO_FALLBACK_DATA_URI = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="64" viewBox="0 0 420 64"><rect x="0.5" y="0.5" width="419" height="63" rx="14" fill="#ffffff" stroke="#cbd5e1"/><rect x="14" y="14" width="36" height="36" rx="10" fill="#0ea5e9"/><circle cx="26" cy="32" r="6" fill="#ffffff"/><circle cx="38" cy="32" r="6" fill="#ffffff"/><text x="62" y="40" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#0f172a">letsconnect.ai</text></svg>'
)}`;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_BRAND_LOGO_FILE_PATH = path.resolve(__dirname, "../assets/letsconnect-logo.png");
const DEFAULT_BRAND_LOGO_DATA_URI = loadDefaultBrandLogoDataUri();

function loadDefaultBrandLogoDataUri() {
  try {
    const imageBytes = fs.readFileSync(DEFAULT_BRAND_LOGO_FILE_PATH);
    if (!imageBytes.length) {
      return DEFAULT_BRAND_LOGO_FALLBACK_DATA_URI;
    }

    return `data:image/png;base64,${imageBytes.toString("base64")}`;
  } catch {
    return DEFAULT_BRAND_LOGO_FALLBACK_DATA_URI;
  }
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

function normalizeAdvisorEmail(value) {
  const candidate = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!candidate) {
    return "";
  }

  const emailMatch = candidate.match(/[a-z0-9._%+-]+@[a-z0-9.-]+/);
  if (emailMatch) {
    return emailMatch[0];
  }

  return candidate.replace(/[<>]/g, "").trim();
}

function normalizeSecretArn(value) {
  const candidate = String(value ?? "").trim();
  return candidate || "";
}

function normalizeAdvisorId(value, fallbackAdvisorId = "advisor") {
  const candidate = String(value ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 254);
  if (candidate) {
    return candidate;
  }

  return String(fallbackAdvisorId ?? "advisor")
    .trim()
    .toLowerCase()
    .slice(0, 254);
}

function deriveAdvisorIdFromEmail(email, fallbackAdvisorId = "advisor") {
  const normalizedEmail = normalizeAdvisorEmail(email);
  if (normalizedEmail) {
    return normalizeAdvisorId(normalizedEmail, fallbackAdvisorId);
  }

  return normalizeAdvisorId(fallbackAdvisorId, "advisor");
}

function normalizeLlmProvider(value, fallbackProvider = DEFAULT_LLM_PROVIDER) {
  const candidate = String(value ?? "")
    .trim()
    .toLowerCase();
  if (ALLOWED_LLM_PROVIDERS.has(candidate)) {
    return candidate;
  }

  return fallbackProvider;
}

function normalizeLlmKeyMode(value, fallbackKeyMode = "platform") {
  const candidate = String(value ?? "")
    .trim()
    .toLowerCase();
  if (ALLOWED_LLM_KEY_MODES.has(candidate)) {
    return candidate;
  }

  return fallbackKeyMode;
}

function normalizeLlmModel(value, fallbackModel = DEFAULT_LLM_MODEL) {
  const candidate = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return candidate || fallbackModel;
}

function normalizeLlmEndpoint(value, fallbackEndpoint = DEFAULT_LLM_ENDPOINT) {
  const candidate = String(value ?? "").trim();
  if (!candidate) {
    return fallbackEndpoint;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:") {
      return fallbackEndpoint;
    }
    return parsed.toString();
  } catch {
    return fallbackEndpoint;
  }
}

function buildAdvisorLlmSecretName({ appName, stage, advisorId }) {
  return `/${appName}/${stage}/${advisorId}/llm/provider`;
}

function normalizeAgentEmailDomain(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9.-]+/g, "");
  return normalized || DEFAULT_AGENT_EMAIL_DOMAIN;
}

function sanitizeAgentMailboxPrefix(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/[._-]{2,}/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48);
  return normalized || "advisor";
}

function deriveDefaultAgentEmail({ advisorId, advisorEmail, domain }) {
  const normalizedDomain = normalizeAgentEmailDomain(domain);
  const normalizedAdvisorEmail = normalizeAdvisorEmail(advisorEmail);
  const advisorIdValue = String(advisorId ?? "").trim().toLowerCase();
  const emailLocalPart = normalizedAdvisorEmail.includes("@") ? normalizedAdvisorEmail.split("@")[0] : "";
  const advisorLocalPart = advisorIdValue.includes("@") ? advisorIdValue.split("@")[0] : advisorIdValue;
  const mailboxPrefix = sanitizeAgentMailboxPrefix(emailLocalPart || advisorLocalPart || "advisor");
  return `${mailboxPrefix}.agent@${normalizedDomain}`;
}

async function ensureUniqueAgentEmail({
  deps,
  advisorSettingsTableName,
  advisorId,
  requestedAgentEmail
}) {
  const normalizedRequested = normalizeAdvisorEmail(requestedAgentEmail);
  if (!normalizedRequested) {
    return "";
  }

  if (!advisorSettingsTableName || typeof deps.getAdvisorSettingsByAgentEmail !== "function") {
    return normalizedRequested;
  }

  const [requestedLocalPart, requestedDomainPart] = normalizedRequested.split("@");
  if (!requestedLocalPart || !requestedDomainPart) {
    return normalizedRequested;
  }

  const normalizedAdvisorId = normalizeAdvisorId(advisorId, "advisor");
  const baseLocalPart = sanitizeAgentMailboxPrefix(requestedLocalPart);
  for (let suffix = 0; suffix < 25; suffix += 1) {
    const candidateLocalPart = suffix === 0 ? baseLocalPart : `${baseLocalPart}.${suffix}`;
    const candidateEmail = `${candidateLocalPart}@${requestedDomainPart}`;
    try {
      const existing = await deps.getAdvisorSettingsByAgentEmail(advisorSettingsTableName, candidateEmail);
      if (!existing || normalizeAdvisorId(existing.advisorId, normalizedAdvisorId) === normalizedAdvisorId) {
        return candidateEmail;
      }
    } catch {
      return normalizedRequested;
    }
  }

  return normalizedRequested;
}

function titleCaseWords(value) {
  return String(value ?? "")
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

function normalizeAdvisorPreferredName(value) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  return normalized;
}

function deriveAdvisorPreferredNameFromEmail(email, advisorId = "advisor") {
  const localPart = String(email ?? "")
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (localPart) {
    return titleCaseWords(localPart).slice(0, 64);
  }

  const fallback = String(advisorId ?? "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (fallback) {
    return titleCaseWords(fallback).slice(0, 64);
  }

  return "Advisor";
}

function deriveAdvisorPreferredNameFromGoogleProfile(profile, advisorId) {
  const explicitName = normalizeAdvisorPreferredName(profile?.name ?? profile?.given_name ?? "");
  if (explicitName) {
    return explicitName;
  }

  return deriveAdvisorPreferredNameFromEmail(profile?.email, advisorId);
}

function normalizeAdvisorSettingsRecord({
  advisorId,
  settings,
  fallbackAdvisorEmail,
  fallbackInviteEmail,
  fallbackPreferredName,
  fallbackTimezone,
  fallbackAgentEmailDomain,
  fallbackLlmProvider = DEFAULT_LLM_PROVIDER,
  fallbackLlmModel = DEFAULT_LLM_MODEL,
  fallbackLlmEndpoint = DEFAULT_LLM_ENDPOINT
}) {
  const normalizedAdvisorId = normalizeAdvisorId(advisorId, "advisor");
  const advisorEmail = normalizeAdvisorEmail(settings?.advisorEmail ?? fallbackAdvisorEmail);
  const inviteEmail = normalizeAdvisorEmail(settings?.inviteEmail ?? fallbackInviteEmail ?? advisorEmail);
  const preferredName = normalizeAdvisorPreferredName(settings?.preferredName ?? fallbackPreferredName);
  const timezone = normalizeTimezone(settings?.timezone, fallbackTimezone);
  const llmProvider = normalizeLlmProvider(settings?.llmProvider, fallbackLlmProvider);
  const llmModel = normalizeLlmModel(settings?.llmModel, fallbackLlmModel);
  const llmEndpoint = normalizeLlmEndpoint(settings?.llmEndpoint, fallbackLlmEndpoint);
  const llmProviderSecretArn = normalizeSecretArn(settings?.llmProviderSecretArn);
  const llmKeyMode = normalizeLlmKeyMode(
    settings?.llmKeyMode,
    llmProviderSecretArn ? "advisor" : "platform"
  );
  const agentEmail = normalizeAdvisorEmail(
    settings?.agentEmail ??
      deriveDefaultAgentEmail({
        advisorId: normalizedAdvisorId,
        advisorEmail,
        domain: fallbackAgentEmailDomain
      })
  );
  const nowIso = new Date().toISOString();

  return {
    advisorId: normalizedAdvisorId,
    advisorEmail,
    agentEmail,
    inviteEmail,
    preferredName: preferredName || deriveAdvisorPreferredNameFromEmail(inviteEmail || advisorEmail, normalizedAdvisorId),
    timezone,
    llmProvider,
    llmModel,
    llmEndpoint,
    llmKeyMode,
    llmProviderSecretArn,
    createdAt: settings?.createdAt ?? nowIso,
    updatedAt: nowIso
  };
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

function deriveClientDisplayNameFromEmail(clientEmail) {
  const localPart = String(clientEmail ?? "")
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!localPart) {
    return "Client";
  }

  return localPart
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ")
    .slice(0, 64);
}

function parseBulkClientEmailList(rawValue) {
  return String(rawValue ?? "")
    .split(/\r?\n/)
    .map((line) => String(line ?? "").trim())
    .filter(Boolean)
    .map((email) => normalizeAdvisorEmail(email))
    .filter(Boolean);
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

function parseMicrosoftAppSecret(secretString) {
  const parsed = JSON.parse(secretString);
  const clientId = String(parsed.client_id ?? "").trim();
  const clientSecret = String(parsed.client_secret ?? "").trim();
  const tenantId = String(parsed.tenant_id ?? "common")
    .trim()
    .toLowerCase() || "common";

  if (!clientId || !clientSecret) {
    throw new Error("Microsoft OAuth app secret is missing client_id or client_secret");
  }

  if (!/^[a-z0-9.-]+$/.test(tenantId)) {
    throw new Error("Microsoft OAuth app secret has invalid tenant_id");
  }

  return { clientId, clientSecret, tenantId };
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

  if (!/\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/i.test(domainName)) {
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
    "/advisor/api/connections/google/callback",
    "/advisor/api/connections/microsoft/callback"
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

function resolveAdvisorPortalAuthMode() {
  return String(process.env.ADVISOR_PORTAL_AUTH_MODE ?? "google_oauth")
    .trim()
    .toLowerCase();
}

function isNoneAuthModeAllowed() {
  return parseBooleanEnv(process.env.ADVISOR_PORTAL_ALLOW_NONE, false);
}

async function readPortalSessionPayload(event, deps) {
  const authMode = resolveAdvisorPortalAuthMode();
  if (authMode !== "google_oauth") {
    return null;
  }

  const sessionSecretArn = process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN;
  if (!sessionSecretArn) {
    return null;
  }

  let sessionSecret;
  try {
    sessionSecret = await getPortalSessionSecret(deps, sessionSecretArn);
  } catch {
    return null;
  }

  const cookies = parseCookies(event);
  const sessionToken = cookies.advisor_portal_session;
  return validatePortalSessionToken(sessionToken, sessionSecret.signingKey);
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

  const authMode = resolveAdvisorPortalAuthMode();
  if (authMode === "none") {
    if (isNoneAuthModeAllowed()) {
      return null;
    }

    return serverError(
      "ADVISOR_PORTAL_AUTH_MODE=none is disabled; use google_oauth or secret_basic."
    );
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

function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
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

function hasOverlappingClientMeetings({ slotStartMs, slotEndMs, clientMeetings }) {
  const clippedClientIntervals = [];
  for (const meeting of clientMeetings) {
    const clipped = clipRangeToSlot(meeting.startMs, meeting.endMs, slotStartMs, slotEndMs);
    if (clipped) {
      clippedClientIntervals.push(clipped);
    }
  }

  if (clippedClientIntervals.length < 2) {
    return false;
  }

  clippedClientIntervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let activeEnd = clippedClientIntervals[0][1];
  for (let index = 1; index < clippedClientIntervals.length; index += 1) {
    const [startMs, endMs] = clippedClientIntervals[index];
    if (startMs < activeEnd) {
      return true;
    }
    if (endMs > activeEnd) {
      activeEnd = endMs;
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
  requestedDurationMinutes,
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
      slotMinutes,
      requestedDurationMinutes
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
      slotMinutes,
      requestedDurationMinutes
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
      const hasMeetingConflict = hasClientMeeting
        ? hasOverlappingClientMeetings({
            slotStartMs,
            slotEndMs,
            clientMeetings: meetingsInSlot
          })
        : false;
      const hasOverlap = hasClientMeeting
        ? hasMeetingConflict ||
          hasBusyOutsideClientMeetings({
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
        hasOverlap,
        fitsRequestedDuration: false
      };
    });

    rows.push({
      cells
    });

    rowStart = rowStart.plus({ minutes: slotMinutes });
  }

  const normalizedRequestedDurationMinutes =
    Number.isFinite(requestedDurationMinutes) && requestedDurationMinutes > 0
      ? Math.max(slotMinutes, Math.trunc(requestedDurationMinutes))
      : slotMinutes;
  const requiredContiguousSlots = Math.max(1, Math.ceil(normalizedRequestedDurationMinutes / slotMinutes));
  if (requiredContiguousSlots > 1) {
    for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const startSlot = rows[rowIndex]?.cells?.[dayIndex];
        if (!startSlot || startSlot.status !== "open") {
          continue;
        }

        let fitsDuration = true;
        for (let offset = 1; offset < requiredContiguousSlots; offset += 1) {
          const nextSlot = rows[rowIndex + offset]?.cells?.[dayIndex];
          if (!nextSlot || nextSlot.status !== "open") {
            fitsDuration = false;
            break;
          }
        }

        startSlot.fitsRequestedDuration = fitsDuration;
      }
    }
  }

  return {
    days,
    rows,
    openSlotCount,
    busySlotCount,
    clientMeetingSlotCount,
    clientOverlapSlotCount,
    slotMinutes,
    requestedDurationMinutes: normalizedRequestedDurationMinutes
  };
}

function formatMeetingStateLabel(advisorResponseStatus) {
  return advisorResponseStatus === "accepted" ? "Accepted" : "Pending";
}

function formatDurationMinutes(durationMinutes) {
  const normalizedMinutes = Number.isFinite(durationMinutes) ? Math.max(0, Math.trunc(durationMinutes)) : 0;
  if (normalizedMinutes <= 0) {
    return "";
  }

  const hours = Math.floor(normalizedMinutes / 60);
  const minutes = normalizedMinutes % 60;
  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${minutes}m`;
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
  windowStartIso,
  windowEndIso,
  expiresAtMs,
  tokenParamName,
  token,
  weekOffset,
  windowLabel,
  clientDisplayName,
  clientReference,
  browserGoogleClientId,
  compareUiEnabled
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
  const compareConfig = {
    enabled: Boolean(compareUiEnabled) && Boolean(browserGoogleClientId),
    clientId: String(browserGoogleClientId ?? ""),
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    timeMinIso: String(windowStartIso ?? ""),
    timeMaxIso: String(windowEndIso ?? ""),
    slotMinutes: Number(calendarModel.slotMinutes ?? 30)
  };
  const requestedDurationHighlightEnabled =
    Number(calendarModel.requestedDurationMinutes ?? 0) > Number(calendarModel.slotMinutes ?? 30);
  const requestedDurationLabel = requestedDurationHighlightEnabled
    ? formatDurationMinutes(calendarModel.requestedDurationMinutes)
    : "";
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
          const localCellClass = [
            "slot",
            "local-slot",
            slot.status,
            requestedDurationHighlightEnabled && slot.fitsRequestedDuration ? "fit-request" : ""
          ]
            .filter(Boolean)
            .join(" ");
          const localCell = `<td class="${localCellClass}" data-slot-key="${escapeHtml(
            slot.slotStartUtc
          )}" data-slot-start-utc="${escapeHtml(slot.slotStartUtc)}" data-slot-end-utc="${escapeHtml(
            slot.slotEndUtc
          )}" data-slot-status="${escapeHtml(slot.status)}">
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
            requestedDurationHighlightEnabled && slot.fitsRequestedDuration ? "fit-request" : "",
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
          <td class="${advisorSlotClass}" data-slot-key="${escapeHtml(slot.slotStartUtc)}" data-slot-start-utc="${escapeHtml(
            slot.slotStartUtc
          )}" data-slot-end-utc="${escapeHtml(slot.slotEndUtc)}" data-slot-status="${escapeHtml(slot.status)}"${rowspanAttr}>
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

  const tokenParam = String(tokenParamName ?? "").trim();
  const tokenValue = String(token ?? "").trim();
  const hasNavToken = tokenParam.length > 0 && tokenValue.length > 0;
  const encodedToken = hasNavToken ? encodeURIComponent(tokenValue) : "";
  const encodedClientReference = clientReference ? encodeURIComponent(clientReference) : "";
  const clientReferenceQuery = encodedClientReference ? `&for=${encodedClientReference}` : "";
  const navPrefix = hasNavToken ? `${tokenParam}=${encodedToken}&` : "";
  const previousWeekOffset = weekOffset - 1;
  const nextWeekOffset = weekOffset + 1;
  const previousHref = `?${navPrefix}weekOffset=${previousWeekOffset}${clientReferenceQuery}`;
  const nextHref = `?${navPrefix}weekOffset=${nextWeekOffset}${clientReferenceQuery}`;
  const previousButton =
    previousWeekOffset < -8
      ? '<span class="nav-link disabled" aria-disabled="true">&lt; Previous Week</span>'
      : `<a class="nav-link" href="${escapeHtml(previousHref)}">&lt; Previous Week</a>`;
  const nextButton =
    nextWeekOffset > 52
      ? '<span class="nav-link disabled" aria-disabled="true">Next Week &gt;</span>'
      : `<a class="nav-link" href="${escapeHtml(nextHref)}">Next Week &gt;</a>`;
  const compareConfigJson = serializeForInlineScript(compareConfig);
  const compareCard = compareConfig.enabled
    ? `<section class="compare-card" id="compare-card">
          <p class="compare-title">Optional: compare with your Google Calendar</p>
          <p class="muted compare-note">Runs only in this browser session. LetsConnect.ai does not store your client calendar token or raw event details.</p>
          <div class="compare-actions">
            <button type="button" class="primary" id="compare-connect">Connect Google Calendar</button>
            <button type="button" id="compare-clear" disabled>Clear compare</button>
          </div>
          <p class="compare-status" id="compare-status">Advisor-only availability is shown right now.</p>
        </section>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Advisor Availability</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #111827; background: #f8fafc; }
      main { max-width: 1280px; margin: 0 auto; }
      h1 { margin-bottom: 8px; }
      code { background: #eef2ff; border-radius: 4px; padding: 1px 4px; }
      .muted { color: #4b5563; margin-top: 0; }
      .hidden-topline { display: none; }
      .brand-header {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 12px;
        margin-bottom: 6px;
      }
      .brand-header .brand-spacer { grid-column: 1; }
      .brand-header .page-title { grid-column: 2; margin: 0; text-align: center; }
      .brand-header .brand-logo { grid-column: 3; justify-self: end; }
      .brand-logo {
        display: block;
        height: 61px;
        width: auto;
        max-width: 260px;
        object-fit: contain;
        background: #ffffff;
        border: 1px solid #d1d5db;
        border-radius: 10px;
        padding: 4px 8px;
      }
      .availability-intro { text-align: center; }
      .availability-intro .muted { text-align: center; }
      .legend { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 14px; color: #374151; font-size: 14px; flex-wrap: wrap; }
      .legend-pill { display: inline-block; padding: 3px 8px; border-radius: 999px; font-weight: 600; font-size: 12px; border: 1px solid; }
      .legend-pill.open { background: #e8f5e9; color: #065f46; border-color: #9dd7a6; }
      .legend-pill.busy { background: #eceff1; color: #374151; border-color: #cbd5e1; }
      .legend-pill.client-accepted { background: #dcfce7; color: #166534; border-color: #86efac; }
      .legend-pill.client-pending { background: #fef9c3; color: #854d0e; border-color: #fde68a; }
      .legend-pill.overlap { background: #fee2e2; color: #991b1b; border-color: #fecaca; }
      .legend-pill.fit-request { background: #82cd72; color: #065f46; border-color: #9dd7a6; }
      .legend-pill.both-open { background: #e0f2fe; color: #075985; border-color: #7dd3fc; }
      .legend-pill.hidden { display: none; }
      .compare-card { border: 1px solid #cbd5e1; border-radius: 10px; background: #ffffff; padding: 12px; margin: 10px 0 14px; }
      .compare-title { margin: 0 0 4px; font-size: 14px; font-weight: 700; color: #0f172a; }
      .compare-note { margin: 0; }
      .compare-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
      .compare-actions button { border: 1px solid #cbd5e1; border-radius: 8px; background: #f8fafc; color: #0f172a; font-weight: 600; font-size: 13px; padding: 7px 10px; cursor: pointer; }
      .compare-actions button.primary { background: #e0f2fe; border-color: #7dd3fc; color: #0c4a6e; }
      .compare-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
      .compare-status { margin: 8px 0 0; font-size: 13px; color: #475569; }
      .compare-status.ok { color: #166534; }
      .compare-status.warn { color: #854d0e; }
      .compare-status.error { color: #991b1b; }
      .summary { font-size: 14px; color: #374151; margin-bottom: 12px; }
      .week-nav { display: flex; align-items: center; justify-content: space-between; margin: 14px 0; gap: 10px; }
      .week-range { font-size: 14px; font-weight: 700; color: #0f172a; text-align: center; flex: 1; }
      .nav-link { text-decoration: none; color: #1d4ed8; font-size: 14px; font-weight: 600; }
      .nav-link:hover { text-decoration: underline; }
      .nav-link.disabled { color: #94a3b8; pointer-events: none; }
      .calendar-carousel { display: flex; align-items: center; gap: 10px; }
      .carousel-viewport { flex: 1; overflow-x: auto; overflow-y: hidden; scroll-behavior: smooth; border-radius: 16px; padding: 2px 4px 2px 2px; }
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
      .calendar-days.centered { width: 100%; min-width: 100%; justify-content: center; }
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
      .slot.fit-request { background: #f4fbf6; }
      .local-slot.fit-request { background: #82cd72; }
      .slot.both-open { background: #e0f2fe; box-shadow: inset 0 0 0 2px #7dd3fc; }
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
      .site-footer { margin-top: 18px; padding-top: 10px; border-top: 1px solid #d1d5db; text-align: center; }
      .copyright { margin: 0; font-size: 12px; color: #475569; font-weight: 600; }
      .powered-by { margin: 4px 0 0; font-size: 12px; color: #64748b; }
      .powered-by.hidden { display: none; }
      @media (max-width: 768px) {
        .calendar-carousel { gap: 6px; }
        .carousel-nav { width: 30px; height: 30px; }
        .calendar-days { gap: 14px; }
        .brand-logo { height: 54px; max-width: 220px; }
      }
    </style>
  </head>
  <body>
    <main>
      <header class="brand-header">
        <span class="brand-spacer" aria-hidden="true"></span>
        <h1 class="page-title">Available Times</h1>
        <img
          id="brand-logo"
          class="brand-logo"
          src="${escapeHtml(DEFAULT_BRAND_LOGO_DATA_URI)}"
          data-default-logo="${escapeHtml(DEFAULT_BRAND_LOGO_DATA_URI)}"
          alt="LetsConnect.ai logo"
        />
      </header>
      <section class="availability-intro">
        ${
          clientDisplayName
            ? `<p class="muted">Availability for <code>${escapeHtml(clientDisplayName)}</code></p>`
            : ""
        }
        <p class="muted">Please find a slot that works for you and send a calendar invitation to the advisor.</p>
        ${
          requestedDurationHighlightEnabled
            ? `<p class="muted">Highlighted start times can fit your requested meeting length of <code>${escapeHtml(
                requestedDurationLabel
              )}</code>.</p>`
            : ""
        }
        <p class="muted">Advisor timezone: <code>${escapeHtml(hostTimezone)}</code> | Local timezone: <code id="local-timezone-code">Detecting...</code></p>
        <p class="muted hidden-topline" aria-hidden="true">Link expires: ${escapeHtml(expiresAtLabel)} (${escapeHtml(hostTimezone)})</p>
      </section>
      <div class="legend">
        <span class="legend-pill open">Open</span>
        <span class="legend-pill busy">Busy</span>
        <span class="legend-pill client-accepted">Your Meeting Accepted</span>
        <span class="legend-pill client-pending">Your Meeting Pending</span>
        <span class="legend-pill overlap">Advisor Calendar Conflict</span>
        ${
          requestedDurationHighlightEnabled
            ? `<span class="legend-pill fit-request">Fits requested ${escapeHtml(requestedDurationLabel)} meeting</span>`
            : ""
        }
        <span id="legend-both-open" class="legend-pill both-open hidden">Open on Both Calendars</span>
      </div>
      ${compareCard}
      <p class="summary" aria-hidden="true">&nbsp;</p>
      <div class="week-nav">
        ${previousButton}
        <div class="week-range">${escapeHtml(windowLabel)}</div>
        ${nextButton}
      </div>
      ${availabilityBody}
      <footer class="site-footer">
        <p class="copyright">${escapeHtml(BRAND_COPYRIGHT_NOTICE)}</p>
        <p id="powered-by" class="powered-by hidden">${escapeHtml(BRAND_POWERED_BY_NOTICE)}</p>
      </footer>
    </main>
    ${
      compareConfig.enabled
        ? '<script src="https://accounts.google.com/gsi/client" async defer></script>'
        : ""
    }
    <script>
      (function () {
        var compareConfig = ${compareConfigJson};
        var compareConnectButton = null;
        var compareClearButton = null;
        var compareStatusNode = null;
        var compareLegendNode = null;
        var clientBusyIntervals = [];
        var compareTokenClient = null;
        var compareAccessToken = '';
        var compareApplied = false;

        function setCompareStatus(message, tone) {
          if (!compareStatusNode) {
            return;
          }
          compareStatusNode.textContent = message;
          compareStatusNode.classList.remove('ok', 'warn', 'error');
          if (tone === 'ok' || tone === 'warn' || tone === 'error') {
            compareStatusNode.classList.add(tone);
          }
        }

        function setCompareButtonsDisabled(disabled) {
          if (compareConnectButton) {
            compareConnectButton.disabled = disabled;
          }
          if (compareClearButton) {
            compareClearButton.disabled = disabled || !compareApplied;
          }
        }

        function clearBothOpenHighlighting() {
          var highlightedSlots = document.querySelectorAll('.slot.both-open');
          highlightedSlots.forEach(function (slot) {
            slot.classList.remove('both-open');
          });
          if (compareLegendNode) {
            compareLegendNode.classList.add('hidden');
          }
          clientBusyIntervals = [];
          compareApplied = false;
        }

        function getSlotIntervals() {
          var localSlots = document.querySelectorAll('.local-slot[data-slot-start-utc][data-slot-end-utc]');
          var advisorSlotByStart = new Map();
          document.querySelectorAll('.advisor-slot[data-slot-start-utc]').forEach(function (advisorSlot) {
            var startIso = advisorSlot.getAttribute('data-slot-start-utc');
            if (startIso) {
              advisorSlotByStart.set(startIso, advisorSlot);
            }
          });

          var slotIntervals = [];
          localSlots.forEach(function (localSlot) {
            var startIso = localSlot.getAttribute('data-slot-start-utc');
            var endIso = localSlot.getAttribute('data-slot-end-utc');
            var status = localSlot.getAttribute('data-slot-status');
            if (!startIso || !endIso || !status) {
              return;
            }

            var startMs = Date.parse(startIso);
            var endMs = Date.parse(endIso);
            if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
              return;
            }

            slotIntervals.push({
              startIso: startIso,
              startMs: startMs,
              endMs: endMs,
              status: status,
              localSlot: localSlot,
              advisorSlot: advisorSlotByStart.get(startIso) || null
            });
          });
          return slotIntervals;
        }

        function hasBusyOverlap(slotStartMs, slotEndMs, busyIntervals) {
          for (var index = 0; index < busyIntervals.length; index += 1) {
            var busyInterval = busyIntervals[index];
            if (slotStartMs < busyInterval.endMs && slotEndMs > busyInterval.startMs) {
              return true;
            }
          }
          return false;
        }

        function applyBothOpenHighlighting() {
          clearBothOpenHighlighting();
          compareApplied = true;
          if (!Array.isArray(clientBusyIntervals) || clientBusyIntervals.length === 0) {
            setCompareStatus('No busy windows were returned from your calendar in this week. All advisor open slots are open for you.', 'ok');
            if (compareLegendNode) {
              compareLegendNode.classList.remove('hidden');
            }
            var noBusySlots = 0;
            getSlotIntervals().forEach(function (slot) {
              if (slot.status !== 'open') {
                return;
              }
              slot.localSlot.classList.add('both-open');
              if (slot.advisorSlot) {
                slot.advisorSlot.classList.add('both-open');
              }
              noBusySlots += 1;
            });
            if (noBusySlots === 0) {
              setCompareStatus('No advisor-open slots are available in this week.', 'warn');
              if (compareLegendNode) {
                compareLegendNode.classList.add('hidden');
              }
            }
            return;
          }

          var bothOpenCount = 0;
          getSlotIntervals().forEach(function (slot) {
            if (slot.status !== 'open') {
              return;
            }
            if (hasBusyOverlap(slot.startMs, slot.endMs, clientBusyIntervals)) {
              return;
            }
            slot.localSlot.classList.add('both-open');
            if (slot.advisorSlot) {
              slot.advisorSlot.classList.add('both-open');
            }
            bothOpenCount += 1;
          });

          if (bothOpenCount > 0) {
            setCompareStatus('Found ' + String(bothOpenCount) + ' slots open on both calendars for this week.', 'ok');
            if (compareLegendNode) {
              compareLegendNode.classList.remove('hidden');
            }
          } else {
            setCompareStatus('No shared open slots found for this week. Use week navigation to check another week.', 'warn');
            if (compareLegendNode) {
              compareLegendNode.classList.add('hidden');
            }
          }
        }

        function initializeGoogleTokenClient() {
          if (compareTokenClient) {
            return compareTokenClient;
          }
          if (
            !window.google ||
            !window.google.accounts ||
            !window.google.accounts.oauth2 ||
            typeof window.google.accounts.oauth2.initTokenClient !== 'function'
          ) {
            return null;
          }
          compareTokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: compareConfig.clientId,
            scope: compareConfig.scope,
            callback: function () {}
          });
          return compareTokenClient;
        }

        function requestGoogleAccessToken() {
          return new Promise(function (resolve, reject) {
            var tokenClient = initializeGoogleTokenClient();
            if (!tokenClient) {
              reject(new Error('Google Sign-In is still loading. Please try again in a moment.'));
              return;
            }

            tokenClient.callback = function (response) {
              if (!response) {
                reject(new Error('Google authorization did not return a token.'));
                return;
              }
              if (response.error) {
                reject(new Error('Google authorization failed: ' + response.error));
                return;
              }
              if (!response.access_token) {
                reject(new Error('Google authorization completed without an access token.'));
                return;
              }
              compareAccessToken = response.access_token;
              resolve(response.access_token);
            };

            tokenClient.requestAccessToken({
              prompt: compareAccessToken ? '' : 'consent'
            });
          });
        }

        function mergeBusyIntervals(intervals) {
          if (!Array.isArray(intervals) || intervals.length <= 1) {
            return Array.isArray(intervals) ? intervals : [];
          }

          var sorted = intervals
            .slice()
            .sort(function (left, right) {
              return left.startMs - right.startMs;
            });
          var merged = [
            {
              startMs: sorted[0].startMs,
              endMs: sorted[0].endMs
            }
          ];

          for (var index = 1; index < sorted.length; index += 1) {
            var current = sorted[index];
            var tail = merged[merged.length - 1];
            if (current.startMs <= tail.endMs) {
              tail.endMs = Math.max(tail.endMs, current.endMs);
              continue;
            }
            merged.push({
              startMs: current.startMs,
              endMs: current.endMs
            });
          }

          return merged;
        }

        async function fetchBrowserCalendarIds(accessToken) {
          var response = await fetch(
            'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&showDeleted=false&showHidden=false&maxResults=250',
            {
              method: 'GET',
              headers: {
                authorization: 'Bearer ' + accessToken
              }
            }
          );

          if (!response.ok) {
            return ['primary'];
          }

          var payload = await response.json();
          var items = payload && Array.isArray(payload.items) ? payload.items : [];
          var calendarIds = [];
          items.forEach(function (item) {
            if (!item || typeof item.id !== 'string') {
              return;
            }
            if (item.deleted === true) {
              return;
            }
            var calendarId = item.id.trim();
            if (!calendarId) {
              return;
            }
            calendarIds.push(calendarId);
          });

          if (calendarIds.length === 0) {
            return ['primary'];
          }
          return Array.from(new Set(calendarIds));
        }

        async function fetchBrowserBusyIntervals(accessToken, fallbackCalendarId) {
          var calendarIds = fallbackCalendarId ? [fallbackCalendarId] : await fetchBrowserCalendarIds(accessToken);
          var body = {
            timeMin: compareConfig.timeMinIso,
            timeMax: compareConfig.timeMaxIso,
            timeZone: 'UTC',
            items: calendarIds.map(function (calendarId) {
              return { id: calendarId };
            })
          };
          var response = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + accessToken,
              'content-type': 'application/json'
            },
            body: JSON.stringify(body)
          });

          if (!response.ok) {
            var responseText = '';
            try {
              responseText = await response.text();
            } catch (_error) {
              responseText = '';
            }
            throw new Error('Google Calendar freeBusy failed (' + String(response.status) + ')' + (responseText ? ': ' + responseText : ''));
          }

          var payload = await response.json();
          var normalizedBusyIntervals = [];
          var calendarsPayload = payload && payload.calendars && typeof payload.calendars === 'object' ? payload.calendars : {};
          Object.keys(calendarsPayload).forEach(function (calendarId) {
            var calendarBusy = Array.isArray(calendarsPayload[calendarId] && calendarsPayload[calendarId].busy)
              ? calendarsPayload[calendarId].busy
              : [];
            calendarBusy.forEach(function (interval) {
              var startMs = Date.parse(interval.start);
              var endMs = Date.parse(interval.end);
              if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
                return;
              }
              normalizedBusyIntervals.push({
                startMs: startMs,
                endMs: endMs
              });
            });
          });

          var mergedBusyIntervals = mergeBusyIntervals(normalizedBusyIntervals);
          if (!fallbackCalendarId && mergedBusyIntervals.length === 0 && !calendarIds.includes('primary')) {
            // Some accounts only return data when querying primary directly.
            return fetchBrowserBusyIntervals(accessToken, 'primary');
          }
          return mergedBusyIntervals;
        }

        async function runBrowserCalendarCompare() {
          if (!compareConfig.enabled) {
            return;
          }
          setCompareButtonsDisabled(true);
          setCompareStatus('Connecting to Google Calendar...', 'warn');
          try {
            var accessToken = await requestGoogleAccessToken();
            setCompareStatus('Reading busy slots from your selected Google calendars...', 'warn');
            clientBusyIntervals = await fetchBrowserBusyIntervals(accessToken);
            applyBothOpenHighlighting();
          } catch (error) {
            clearBothOpenHighlighting();
            setCompareStatus(
              (error && error.message ? error.message : 'Unable to compare calendars right now.') +
                ' Showing advisor-only availability.',
              'error'
            );
          } finally {
            setCompareButtonsDisabled(false);
          }
        }

        function clearBrowserCalendarCompare() {
          compareAccessToken = '';
          clearBothOpenHighlighting();
          compareApplied = false;
          setCompareStatus('Advisor-only availability is shown right now.', null);
          if (compareClearButton) {
            compareClearButton.disabled = true;
          }
        }

        function applyBrandingFromStorage() {
          var logoNode = document.getElementById('brand-logo');
          var poweredByNode = document.getElementById('powered-by');
          if (!logoNode) {
            return;
          }

          var defaultLogo = logoNode.getAttribute('data-default-logo') || logoNode.getAttribute('src') || '';
          var customLogo = '';
          try {
            customLogo = localStorage.getItem('${BRAND_STORAGE_KEY}') || '';
          } catch (_error) {
            customLogo = '';
          }

          logoNode.setAttribute('src', customLogo || defaultLogo);
          if (poweredByNode) {
            poweredByNode.classList.toggle('hidden', !customLogo);
          }
        }

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

            var hasMoreCards = cards.length > cardsPerView;
            var visibleCardCount = hasMoreCards ? cardsPerView : Math.max(1, cards.length);
            var peekPx = hasMoreCards ? Math.max(gapPx + 24, Math.round(viewportWidth * 0.10)) : 0;
            var cardWidth = (viewportWidth - gapPx * (visibleCardCount - 1) - peekPx) / visibleCardCount;

            if (!hasMoreCards) {
              var maxCenteredWidth = visibleCardCount === 1 ? 620 : 520;
              cardWidth = Math.min(cardWidth, maxCenteredWidth);
            }

            var normalizedCardWidth = Math.max(240, Math.floor(cardWidth));
            cards.forEach(function (card) {
              card.style.width = normalizedCardWidth + 'px';
            });
            track.classList.toggle('centered', !hasMoreCards);

            var maxScrollLeft = measureMaxScrollLeft();
            if (!hasMoreCards) {
              viewport.scrollLeft = 0;
            }
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
        compareConnectButton = document.getElementById('compare-connect');
        compareClearButton = document.getElementById('compare-clear');
        compareStatusNode = document.getElementById('compare-status');
        compareLegendNode = document.getElementById('legend-both-open');
        applyBrandingFromStorage();
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

        if (compareConfig.enabled && compareConnectButton && compareClearButton) {
          compareConnectButton.addEventListener('click', function () {
            runBrowserCalendarCompare().catch(function () {
              setCompareStatus('Unable to compare calendars right now. Showing advisor-only availability.', 'error');
            });
          });
          compareClearButton.addEventListener('click', function () {
            clearBrowserCalendarCompare();
          });
          window.addEventListener('beforeunload', function () {
            compareAccessToken = '';
            clientBusyIntervals = [];
          });
        }

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

function buildAdvisorCalendarPage({
  calendarModel,
  hostTimezone,
  weekOffset,
  windowLabel,
  advisorDisplayName
}) {
  const advisorCellSpanPlan = buildAdvisorCellSpanPlan(calendarModel.rows, calendarModel.days.length);
  const previousWeekOffset = weekOffset - 1;
  const nextWeekOffset = weekOffset + 1;
  const previousButton =
    previousWeekOffset < -8
      ? '<span class="nav-link disabled" aria-disabled="true">&lt; Previous Week</span>'
      : `<a class="nav-link" href="?weekOffset=${previousWeekOffset}">&lt; Previous Week</a>`;
  const nextButton =
    nextWeekOffset > 52
      ? '<span class="nav-link disabled" aria-disabled="true">Next Week &gt;</span>'
      : `<a class="nav-link" href="?weekOffset=${nextWeekOffset}">Next Week &gt;</a>`;

  const dayCards = calendarModel.days
    .map((day, dayIndex) => {
      const rowsHtml = calendarModel.rows
        .map((row, rowIndex) => {
          const slot = row.cells[dayIndex];
          const spanPlan = advisorCellSpanPlan[rowIndex]?.[dayIndex] ?? { render: true, rowspan: 1 };
          if (!spanPlan.render) {
            return "";
          }

          const meetingDetails = slot.hasClientMeeting
            ? `<div class="meeting-list">${slot.clientMeetings
                .map(
                  (meeting) =>
                    `<div class="meeting-item"><span class="meeting-title">${escapeHtml(
                      meeting.title
                    )}</span><span class="meeting-state ${escapeHtml(meeting.advisorResponseStatus)}">${formatMeetingStateLabel(
                      meeting.advisorResponseStatus
                    )}</span></div>`
                )
                .join("")}</div>`
            : "";
          const hostTimeLabel =
            spanPlan.rowspan > 1
              ? `${slot.hostLabel} - ${calendarModel.rows[rowIndex + spanPlan.rowspan - 1]?.cells?.[dayIndex]?.hostEndLabel ?? slot.hostEndLabel}`
              : slot.hostLabel;
          const rowspanAttr = spanPlan.rowspan > 1 ? ` rowspan="${spanPlan.rowspan}"` : "";
          const slotClasses = [
            "slot",
            slot.status,
            slot.hasClientMeeting ? `client-${slot.clientMeetingState}` : "",
            slot.hasOverlap ? "client-overlap" : "",
            spanPlan.rowspan > 1 ? "merged-span" : ""
          ]
            .filter(Boolean)
            .join(" ");
          const overlapPill = slot.hasOverlap ? '<div class="slot-pill overlap">Potential conflict</div>' : "";

          return `<tr>
            <td class="${slotClasses}"${rowspanAttr}>
              <div class="slot-pill ${slot.status}">${slot.status === "open" ? "Open" : "Busy"}</div>
              ${overlapPill}
              <div class="slot-host">${escapeHtml(hostTimeLabel)}</div>
              ${meetingDetails}
            </td>
          </tr>`;
        })
        .join("");

      return `<section class="day-card">
        <table class="day-table">
          <thead>
            <tr>
              <th>
                <div class="weekday">${escapeHtml(day.weekdayLabel)}</div>
                <div class="date">${escapeHtml(day.dateLabel)}</div>
              </th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Advisor Calendar</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #111827; background: #f8fafc; }
      main { max-width: 1320px; margin: 0 auto; }
      .brand-header {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 12px;
        margin-bottom: 6px;
      }
      .brand-header .brand-spacer { grid-column: 1; }
      .brand-header .page-title { grid-column: 2; margin: 0; text-align: center; }
      .brand-header .brand-logo { grid-column: 3; justify-self: end; }
      .brand-logo {
        display: block;
        height: 61px;
        width: auto;
        max-width: 260px;
        object-fit: contain;
        background: #ffffff;
        border: 1px solid #d1d5db;
        border-radius: 10px;
        padding: 4px 8px;
      }
      .muted { color: #4b5563; margin-top: 0; }
      .legend { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 14px; color: #374151; font-size: 14px; flex-wrap: wrap; }
      .legend-pill { display: inline-block; padding: 3px 8px; border-radius: 999px; font-weight: 600; font-size: 12px; border: 1px solid; }
      .legend-pill.open { background: #e8f5e9; color: #065f46; border-color: #9dd7a6; }
      .legend-pill.busy { background: #eceff1; color: #374151; border-color: #cbd5e1; }
      .legend-pill.client-accepted { background: #dcfce7; color: #166534; border-color: #86efac; }
      .legend-pill.client-pending { background: #fef9c3; color: #854d0e; border-color: #fde68a; }
      .legend-pill.overlap { background: #fee2e2; color: #991b1b; border-color: #fecaca; }
      .week-nav { display: flex; align-items: center; justify-content: space-between; margin: 14px 0; gap: 10px; }
      .week-range { font-size: 14px; font-weight: 700; color: #0f172a; text-align: center; flex: 1; }
      .nav-link { text-decoration: none; color: #1d4ed8; font-size: 14px; font-weight: 600; }
      .nav-link:hover { text-decoration: underline; }
      .nav-link.disabled { color: #94a3b8; pointer-events: none; }
      .day-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
      .day-card { background: #fff; border: 1px solid #d1d5db; border-radius: 14px; overflow: hidden; }
      .day-table { width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; }
      .day-table th, .day-table td { border-bottom: 1px solid #e2e8f0; padding: 8px; vertical-align: top; }
      .day-table tr:last-child td { border-bottom: 0; }
      .day-table thead th { background: #f1f5f9; }
      .weekday { font-size: 12px; text-transform: uppercase; color: #64748b; letter-spacing: 0.04em; }
      .date { font-size: 14px; font-weight: 700; color: #0f172a; }
      .slot { min-height: 56px; background: #ffffff; }
      .slot.open { background: #f4fbf6; }
      .slot.busy { background: #f8fafc; }
      .slot.client-accepted { background: #ecfdf5; }
      .slot.client-pending { background: #fffbeb; }
      .slot.client-overlap { box-shadow: inset 0 0 0 2px #fca5a5; }
      .slot-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; border: 1px solid; }
      .slot-pill.open { color: #065f46; background: #dcfce7; border-color: #86efac; }
      .slot-pill.busy { color: #334155; background: #e2e8f0; border-color: #cbd5e1; }
      .slot-pill.overlap { color: #991b1b; background: #fee2e2; border-color: #fca5a5; margin-left: 6px; }
      .slot-host { margin-top: 6px; font-size: 12px; font-weight: 700; color: #0f172a; }
      .meeting-list { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
      .meeting-item { font-size: 12px; line-height: 1.3; display: flex; flex-direction: column; gap: 2px; padding: 4px 6px; border: 1px solid #d1d5db; border-radius: 6px; background: #ffffff; }
      .meeting-title { font-weight: 600; color: #0f172a; word-break: break-word; }
      .meeting-state { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
      .meeting-state.accepted { color: #166534; }
      .meeting-state.pending { color: #854d0e; }
      .site-footer { margin-top: 18px; padding-top: 10px; border-top: 1px solid #d1d5db; text-align: center; }
      .copyright { margin: 0; font-size: 12px; color: #475569; font-weight: 600; }
      .powered-by { margin: 4px 0 0; font-size: 12px; color: #64748b; }
      .powered-by.hidden { display: none; }
      @media (max-width: 768px) {
        .brand-logo { height: 54px; max-width: 220px; }
      }
    </style>
  </head>
  <body>
    <main>
      <header class="brand-header">
        <span class="brand-spacer" aria-hidden="true"></span>
        <h1 class="page-title">Advisor Calendar</h1>
        <img
          id="brand-logo"
          class="brand-logo"
          src="${escapeHtml(DEFAULT_BRAND_LOGO_DATA_URI)}"
          data-default-logo="${escapeHtml(DEFAULT_BRAND_LOGO_DATA_URI)}"
          alt="LetsConnect.ai logo"
        />
      </header>
      <p class="muted">Combined calendar view for ${escapeHtml(advisorDisplayName || "advisor")} across all connected calendars.</p>
      <p class="muted">Timezone: <code>${escapeHtml(hostTimezone)}</code></p>
      <div class="legend">
        <span class="legend-pill open">Open</span>
        <span class="legend-pill busy">Busy</span>
        <span class="legend-pill client-accepted">Accepted</span>
        <span class="legend-pill client-pending">Pending</span>
        <span class="legend-pill overlap">Potential conflict</span>
      </div>
      <div class="week-nav">
        ${previousButton}
        <div class="week-range">${escapeHtml(windowLabel)}</div>
        ${nextButton}
      </div>
      <div class="day-cards">${dayCards}</div>
      <footer class="site-footer">
        <p class="copyright">${escapeHtml(BRAND_COPYRIGHT_NOTICE)}</p>
        <p id="powered-by" class="powered-by hidden">${escapeHtml(BRAND_POWERED_BY_NOTICE)}</p>
      </footer>
    </main>
  </body>
</html>`;
}

function buildAdvisorCalendarUnavailablePage({ advisorDisplayName }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Advisor Calendar</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #111827; background: #f8fafc; }
      main { max-width: 860px; margin: 0 auto; }
      .card { background: #fff; border: 1px solid #d1d5db; border-radius: 14px; padding: 18px; }
      h1 { margin: 0 0 8px; }
      p { margin: 8px 0; color: #4b5563; }
      a { color: #1d4ed8; font-weight: 600; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .site-footer { margin-top: 18px; padding-top: 10px; border-top: 1px solid #d1d5db; text-align: center; }
      .copyright { margin: 0; font-size: 12px; color: #475569; font-weight: 600; }
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <h1>Advisor Calendar</h1>
        <p>No connected calendars were found for ${escapeHtml(advisorDisplayName || "this advisor")}.</p>
        <p>Connect at least one calendar from the advisor portal before opening this view.</p>
        <p><a href="./advisor">Return to Advisor Portal</a></p>
      </section>
      <footer class="site-footer">
        <p class="copyright">${escapeHtml(BRAND_COPYRIGHT_NOTICE)}</p>
      </footer>
    </main>
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
  microsoftOauthSecretArn,
  searchStartIso,
  searchEndIso,
  clientEmail,
  includeAllMeetings = false
}) {
  const sortByUpdatedAtDesc = (connections) =>
    [...connections].sort((left, right) => String(right?.updatedAt ?? "").localeCompare(String(left?.updatedAt ?? "")));

  const getConnectedConnections = async () => {
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

    return sortByUpdatedAtDesc(
      (Array.isArray(connections) ? connections : []).filter(
        (connection) => String(connection?.status ?? "").toLowerCase() === "connected"
      )
    );
  };

  const lookupWithOauthConfig = async ({ provider, oauthConfig, advisorEmailHint }) => {
    const busyIntervals = await deps.lookupBusyIntervals({
      provider,
      oauthConfig,
      windowStartIso: searchStartIso,
      windowEndIso: searchEndIso,
      fetchImpl: deps.fetchImpl
    });

    let clientMeetings = [];
    let nonClientBusyIntervals = [];
    if (includeAllMeetings && typeof deps.lookupAdvisorMeetings === "function") {
      try {
        const advisorMeetings = await deps.lookupAdvisorMeetings({
          provider,
          oauthConfig,
          windowStartIso: searchStartIso,
          windowEndIso: searchEndIso,
          advisorEmailHint,
          fetchImpl: deps.fetchImpl
        });
        clientMeetings = Array.isArray(advisorMeetings) ? advisorMeetings : [];
      } catch {
        clientMeetings = [];
      }
    } else if (clientEmail && typeof deps.lookupClientMeetings === "function") {
      try {
        const clientMeetingOverlay = await deps.lookupClientMeetings({
          provider,
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
    return lookupWithOauthConfig({ provider: "google", oauthConfig });
  }

  if (calendarMode === "microsoft") {
    if (!microsoftOauthSecretArn) {
      throw new Error("MICROSOFT_OAUTH_SECRET_ARN is required for CALENDAR_MODE=microsoft");
    }

    const secretString = await deps.getSecretString(microsoftOauthSecretArn);
    const oauthConfig = parseMicrosoftOauthSecret(secretString);
    return lookupWithOauthConfig({ provider: "microsoft", oauthConfig });
  }

  if (calendarMode === "connection") {
    if (!connectionsTableName) {
      throw new Error("CONNECTIONS_TABLE_NAME is required for CALENDAR_MODE=connection");
    }

    const connectedConnections = await getConnectedConnections();
    if (connectedConnections.length === 0) {
      return {
        busyIntervals: [],
        clientMeetings: [],
        nonClientBusyIntervals: []
      };
    }

    const mergedBusyIntervals = [];
    const mergedClientMeetings = [];
    const mergedNonClientBusyIntervals = [];

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
        const context = await lookupWithOauthConfig({
          provider: "google",
          oauthConfig,
          advisorEmailHint: connection.accountEmail
        });
        mergedBusyIntervals.push(...context.busyIntervals);
        mergedClientMeetings.push(...context.clientMeetings);
        mergedNonClientBusyIntervals.push(...context.nonClientBusyIntervals);
        continue;
      }

      if (connection.provider === "microsoft") {
        if (!connection.secretArn) {
          throw new Error("Microsoft connection is missing secretArn");
        }

        const secretString = await deps.getSecretString(connection.secretArn);
        const oauthConfig = parseMicrosoftOauthSecret(secretString);
        const context = await lookupWithOauthConfig({
          provider: "microsoft",
          oauthConfig,
          advisorEmailHint: connection.accountEmail
        });
        mergedBusyIntervals.push(...context.busyIntervals);
        mergedClientMeetings.push(...context.clientMeetings);
        mergedNonClientBusyIntervals.push(...context.nonClientBusyIntervals);
        continue;
      }

      throw new Error(`Unsupported provider for availability lookup: ${connection.provider}`);
    }

    return {
      busyIntervals: mergedBusyIntervals.sort((left, right) => Date.parse(left.startIso) - Date.parse(right.startIso)),
      clientMeetings: mergedClientMeetings.sort((left, right) => Date.parse(left.startIso) - Date.parse(right.startIso)),
      nonClientBusyIntervals: mergedNonClientBusyIntervals.sort(
        (left, right) => Date.parse(left.startIso) - Date.parse(right.startIso)
      )
    };
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

function normalizeUsageWindow(value) {
  const candidate = String(value ?? "")
    .trim()
    .toLowerCase();
  return Object.hasOwn(USAGE_WINDOW_DAYS, candidate) ? candidate : DEFAULT_USAGE_WINDOW;
}

function estimateTokenCostUsd({ inputTokens, outputTokens, inputPer1K, outputPer1K }) {
  const normalizedInput = toNonNegativeInteger(inputTokens);
  const normalizedOutput = toNonNegativeInteger(outputTokens);
  return (normalizedInput / 1000) * inputPer1K + (normalizedOutput / 1000) * outputPer1K;
}

function deriveFallbackLlmRequestCount(trace) {
  let count = 0;
  const llmStatus = String(trace?.llmStatus ?? "")
    .trim()
    .toLowerCase();
  const intentLlmStatus = String(trace?.intentLlmStatus ?? "")
    .trim()
    .toLowerCase();
  const promptGuardLlmStatus = String(trace?.promptGuardLlmStatus ?? "")
    .trim()
    .toLowerCase();

  if (llmStatus === "ok" || llmStatus === "fallback") {
    count += 1;
  }
  if (intentLlmStatus === "ok" || intentLlmStatus === "fallback") {
    count += 1;
  }
  if (promptGuardLlmStatus === "ok" || promptGuardLlmStatus === "fallback") {
    count += 1;
  }

  return count;
}

function estimateEmailSendsFromTrace(trace) {
  if (String(trace?.responseMode ?? "").toLowerCase() !== "send") {
    return 0;
  }

  const status = String(trace?.status ?? "").toLowerCase();
  if (status === "suppressed" || status === "denied") {
    return 0;
  }

  const bookingStatus = String(trace?.bookingStatus ?? "").toLowerCase();
  if (bookingStatus === "invite_sent") {
    return Math.max(1, toNonNegativeInteger(trace?.inviteRecipientCount));
  }

  return 1;
}

function estimateCalendarApiCallsFromTrace(trace) {
  const providerStatus = String(trace?.providerStatus ?? "").toLowerCase();
  return providerStatus === "ok" || providerStatus === "error" ? 1 : 0;
}

function buildAdvisorUsageSummary({
  traces,
  advisorId,
  window,
  startIso,
  endIso,
  llmInputCostPer1KUsd,
  llmOutputCostPer1KUsd,
  emailSendCostUsd,
  calendarApiCallCostUsd,
  lambdaInvocationCostUsd
}) {
  const totals = {
    invocationCount: 0,
    emailSendCount: 0,
    calendarApiCallCount: 0,
    llmRequestCount: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
    llmTotalTokens: 0,
    llmEstimatedCostUsd: 0,
    infraEstimatedCostUsd: 0,
    estimatedTotalCostUsd: 0
  };
  const byModelMap = new Map();

  for (const trace of Array.isArray(traces) ? traces : []) {
    totals.invocationCount += 1;

    const llmProvider = String(trace?.llmProvider ?? "")
      .trim()
      .toLowerCase() || String(trace?.llmMode ?? "").trim().toLowerCase() || "unknown";
    const llmModel = String(trace?.llmModel ?? "").trim() || "unknown";
    const llmRequestCountRaw = toNonNegativeInteger(trace?.llmRequestCount);
    const llmRequestCount = llmRequestCountRaw > 0 ? llmRequestCountRaw : deriveFallbackLlmRequestCount(trace);
    const llmInputTokens = toNonNegativeInteger(trace?.llmInputTokens);
    const llmOutputTokens = toNonNegativeInteger(trace?.llmOutputTokens);
    const llmTotalTokens = toNonNegativeInteger(
      trace?.llmTotalTokens || llmInputTokens + llmOutputTokens
    );
    const llmEstimatedCostUsd = estimateTokenCostUsd({
      inputTokens: llmInputTokens,
      outputTokens: llmOutputTokens,
      inputPer1K: llmInputCostPer1KUsd,
      outputPer1K: llmOutputCostPer1KUsd
    });

    totals.llmRequestCount += llmRequestCount;
    totals.llmInputTokens += llmInputTokens;
    totals.llmOutputTokens += llmOutputTokens;
    totals.llmTotalTokens += llmTotalTokens;
    totals.llmEstimatedCostUsd += llmEstimatedCostUsd;

    if (llmRequestCount > 0 || llmTotalTokens > 0) {
      const modelKey = `${llmProvider}|${llmModel}`;
      const existingModelMetrics = byModelMap.get(modelKey) ?? {
        provider: llmProvider,
        model: llmModel,
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0
      };
      existingModelMetrics.requestCount += llmRequestCount;
      existingModelMetrics.inputTokens += llmInputTokens;
      existingModelMetrics.outputTokens += llmOutputTokens;
      existingModelMetrics.totalTokens += llmTotalTokens;
      existingModelMetrics.estimatedCostUsd += llmEstimatedCostUsd;
      byModelMap.set(modelKey, existingModelMetrics);
    }

    totals.emailSendCount += estimateEmailSendsFromTrace(trace);
    totals.calendarApiCallCount += estimateCalendarApiCallsFromTrace(trace);
  }

  const lambdaInvocationEstimate = totals.invocationCount * lambdaInvocationCostUsd;
  const emailSendEstimate = totals.emailSendCount * emailSendCostUsd;
  const calendarApiEstimate = totals.calendarApiCallCount * calendarApiCallCostUsd;
  totals.infraEstimatedCostUsd = lambdaInvocationEstimate + emailSendEstimate + calendarApiEstimate;
  totals.estimatedTotalCostUsd = totals.llmEstimatedCostUsd + totals.infraEstimatedCostUsd;

  const byModel = Array.from(byModelMap.values()).sort((left, right) => {
    if (right.totalTokens !== left.totalTokens) {
      return right.totalTokens - left.totalTokens;
    }

    return String(left.model).localeCompare(String(right.model));
  });

  return {
    advisorId,
    window,
    range: {
      startIso,
      endIso
    },
    totals,
    byModel,
    assumptions: {
      llmInputCostPer1KUsd,
      llmOutputCostPer1KUsd,
      emailSendCostUsd,
      calendarApiCallCostUsd,
      lambdaInvocationCostUsd
    }
  };
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
    llmProvider: trace.llmProvider,
    llmModel: trace.llmModel,
    llmRequestCount: trace.llmRequestCount,
    llmInputTokens: trace.llmInputTokens,
    llmOutputTokens: trace.llmOutputTokens,
    llmTotalTokens: trace.llmTotalTokens,
    intentSource: trace.intentSource,
    intentLlmStatus: trace.intentLlmStatus,
    requestedWindowCount: trace.requestedWindowCount,
    admissionDecision: trace.admissionDecision,
    admissionReason: trace.admissionReason,
    senderHash: trace.senderHash,
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

  if (trace.status === "suppressed" && trace.admissionDecision === "blackhole") {
    categories.push("admission_suppressed");
    actions.push("Sender is not in advisor allowlist/client directory. Add or import client in Advisor Portal if this sender should be allowed.");
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

function buildAdvisorLandingPage({ googleLoginUrl }) {
  const safeGoogleLoginUrl = escapeHtml(googleLoginUrl);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LetsConnect.ai | Advisor Sign-In</title>
    <style>
      :root {
        --bg-1: #edf4ff;
        --bg-2: #dceaff;
        --bg-3: #f4f8ff;
        --ink-900: #09172a;
        --ink-700: #2c3f58;
        --ink-600: #4b627f;
        --ink-500: #617b9b;
        --surface: #ffffff;
        --line: #cfe0f3;
        --brand-700: #0857b2;
        --brand-500: #2b7bda;
        --shadow: 0 25px 60px rgba(13, 40, 79, 0.12);
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--ink-900);
        font-family: "Avenir Next", "Segoe UI Variable", "Gill Sans", "Trebuchet MS", sans-serif;
        background:
          radial-gradient(780px 480px at -5% 10%, rgba(36, 117, 214, 0.22), transparent 56%),
          radial-gradient(820px 480px at 110% 30%, rgba(102, 175, 255, 0.16), transparent 58%),
          linear-gradient(180deg, var(--bg-1), var(--bg-3) 50%, #f8fbff 100%);
        display: grid;
        place-items: center;
        padding: 26px 14px;
      }
      .shell {
        width: min(1080px, 100%);
      }
      .panel {
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid var(--line);
        border-radius: 28px;
        box-shadow: var(--shadow);
        overflow: hidden;
      }
      .grid {
        display: grid;
        grid-template-columns: 1.08fr 0.92fr;
      }
      .content {
        padding: 40px 42px 30px;
      }
      h1 {
        margin: 0 0 10px;
        line-height: 1.05;
        letter-spacing: -0.02em;
        font-size: clamp(34px, 5vw, 52px);
      }
      .lead {
        margin: 0;
        color: var(--ink-700);
        font-size: 18px;
        line-height: 1.5;
        max-width: 54ch;
      }
      .proof-grid {
        margin-top: 24px;
        display: grid;
        grid-template-columns: repeat(3, minmax(150px, 1fr));
        gap: 10px;
      }
      .proof-card {
        border: 1px solid #d7e6f7;
        border-radius: 14px;
        background: linear-gradient(180deg, #fafdff, #f3f8ff);
        padding: 12px 10px;
      }
      .proof-title {
        margin: 0;
        color: #0d3f75;
        font-size: 13px;
        font-weight: 800;
        letter-spacing: 0.01em;
      }
      .proof-copy {
        margin: 5px 0 0;
        color: var(--ink-600);
        font-size: 12px;
        line-height: 1.35;
      }
      .cta-row {
        margin-top: 18px;
      }
      .cta {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 12px;
        padding: 13px 18px;
        text-decoration: none;
        font-weight: 800;
        letter-spacing: 0.01em;
        border: 1px solid #1b5aaa;
        background: linear-gradient(180deg, var(--brand-500), var(--brand-700));
        color: #fff;
        box-shadow: 0 12px 22px rgba(21, 86, 164, 0.28);
        transition: transform 140ms ease, box-shadow 140ms ease, filter 140ms ease;
      }
      .cta:hover {
        transform: translateY(-1px);
        box-shadow: 0 16px 26px rgba(21, 86, 164, 0.34);
        filter: saturate(1.06);
      }
      .cta:active {
        transform: translateY(0);
      }
      .note {
        margin-top: 10px;
        color: #577596;
        text-align: center;
        font-size: 13px;
      }
      .right {
        position: relative;
        background:
          linear-gradient(180deg, rgba(240, 248, 255, 0.95), rgba(230, 242, 255, 0.93)),
          linear-gradient(125deg, #e9f3ff 0%, #d9eaff 100%);
        border-left: 1px solid #d6e5f5;
        padding: 28px 26px;
      }
      .logo-frame {
        width: fit-content;
        margin-left: auto;
        border: 1px solid #c9dcf1;
        border-radius: 14px;
        background: #fff;
        padding: 8px 10px;
      }
      .logo {
        height: 72px;
        width: auto;
        object-fit: contain;
        display: block;
      }
      .stack {
        margin-top: 22px;
        display: grid;
        gap: 10px;
      }
      .mini {
        border: 1px solid #cfe0f3;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.88);
        padding: 12px 12px 11px;
      }
      .mini h3 {
        margin: 0;
        color: #17487d;
        font-size: 13px;
        font-weight: 800;
        letter-spacing: 0.01em;
      }
      .mini p {
        margin: 6px 0 0;
        color: var(--ink-600);
        font-size: 12px;
        line-height: 1.45;
      }
      .right .cta {
        width: 100%;
      }
      .copyright-global {
        margin: 14px 0 0;
        color: #577596;
        font-size: 13px;
        font-weight: 600;
        text-align: center;
      }
      @media (max-width: 980px) {
        .grid {
          grid-template-columns: 1fr;
        }
        .right {
          border-left: 0;
          border-top: 1px solid #d6e5f5;
          padding-top: 16px;
        }
        .logo-frame {
          margin: 0;
        }
      }
      @media (max-width: 700px) {
        .content {
          padding: 28px 20px 24px;
        }
        .proof-grid {
          grid-template-columns: 1fr;
        }
        .logo {
          height: 62px;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="panel">
        <div class="grid">
          <div class="content">
            <h1>Turn inbound scheduling email into confirmed meetings.</h1>
            <p class="lead">
              Sign in once with Google to activate your advisor workspace, connect calendars,
              and let the agent handle professional back-and-forth with clients.
            </p>
            <div class="proof-grid">
              <article class="proof-card">
                <p class="proof-title">Unified Calendar Logic</p>
                <p class="proof-copy">Checks all connected calendars before suggesting slots.</p>
              </article>
              <article class="proof-card">
                <p class="proof-title">Strict Client Controls</p>
                <p class="proof-copy">Replies only to allowed clients and advisor-managed contacts.</p>
              </article>
              <article class="proof-card">
                <p class="proof-title">Privacy-First Traces</p>
                <p class="proof-copy">Debug metadata without retaining email/calendar content.</p>
              </article>
            </div>
          </div>
          <aside class="right">
            <div class="logo-frame">
              <img class="logo" src="${DEFAULT_BRAND_LOGO_DATA_URI}" alt="letsconnect.ai logo" />
            </div>
            <div class="stack">
              <article class="mini">
                <h3>What this gives you</h3>
                <p>Client directory, policy cohorts, calendar connection management, and trace visibility from one portal.</p>
              </article>
              <article class="mini">
                <h3>Privacy First</h3>
                <p>All Lambda: No calendar data stored anywhere. Bring your own LLM.</p>
              </article>
              <article class="mini">
                <h3>Brand control</h3>
                <p>Use default LetsConnect branding or switch to advisor logo/cobranding from workspace settings.</p>
              </article>
            </div>
            <div class="cta-row">
              <a class="cta" href="${safeGoogleLoginUrl}" id="landingGoogleSignIn">Login with Google</a>
            </div>
            <p class="note">First login creates your advisor account and default agent settings.</p>
          </aside>
        </div>
      </section>
      <p class="copyright-global">${escapeHtml(BRAND_COPYRIGHT_NOTICE)}</p>
    </main>
  </body>
</html>`;
}

function buildAdvisorPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Advisor Portal - Connected Calendars</title>
    <style>
      :root {
        --bg-top: #ecf4ff;
        --bg-bottom: #f6f8fc;
        --ink-900: #0f172a;
        --ink-700: #334155;
        --ink-600: #475569;
        --ink-500: #64748b;
        --line: #d8e1ec;
        --surface: #ffffff;
        --surface-soft: #f8fbff;
        --brand: #0b6bbf;
        --brand-strong: #0a4f8e;
        --success: #0f9d58;
        --warn: #c77b1e;
        --danger: #be2f3f;
        --shadow: 0 12px 40px rgba(15, 23, 42, 0.09);
      }
      * { box-sizing: border-box; }
      body {
        font-family: "Avenir Next", "Segoe UI Variable", "Gill Sans", "Trebuchet MS", sans-serif;
        margin: 0;
        min-height: 100%;
        background: linear-gradient(180deg, var(--bg-top), var(--bg-bottom));
        color: var(--ink-900);
      }
      .portal-shell { display: grid; grid-template-columns: 260px 1fr; min-height: 100vh; }
      .portal-sidebar { border-right: 1px solid var(--line); background: linear-gradient(180deg, #ffffff, #f3f7fd); padding: 16px 12px; }
      .portal-main { padding: 18px; }
      .portal-brand-header {
        border: 1px solid var(--line);
        border-radius: 14px;
        background: #fff;
        padding: 12px;
        margin-bottom: 10px;
      }
      .portal-page-title { margin: 0 0 8px; font-size: 22px; color: var(--ink-900); letter-spacing: 0.01em; }
      .sidebar-note { margin: 0 0 12px; font-size: 12px; color: var(--ink-600); }
      .portal-brand-logo {
        display: block;
        height: 62px;
        width: auto;
        max-width: 220px;
        object-fit: contain;
        background: #ffffff;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 4px 8px;
      }
      .sidebar-actions { margin-top: 10px; display: flex; justify-content: center; }
      .portal-main-header { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px; }
      .portal-main-actions { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
      .advisor-header-title { margin: 0; font-size: 28px; color: var(--ink-900); letter-spacing: 0.01em; }
      .advisor-header-meta { margin: 4px 0 0; color: var(--ink-600); font-size: 13px; }
      .card {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 16px;
        margin-bottom: 16px;
        box-shadow: var(--shadow);
      }
      h1 { margin-top: 0; }
      button {
        border: 1px solid var(--line);
        background: #fff;
        color: var(--ink-700);
        border-radius: 10px;
        padding: 8px 12px;
        margin-right: 8px;
        cursor: pointer;
        font-weight: 700;
        transition: background 120ms ease, border-color 120ms ease;
      }
      button:hover {
        background: #f5f9ff;
        border-color: #bfd2e8;
      }
      .primary-button {
        background: linear-gradient(180deg, #1d4ed8, #1e40af);
        border-color: #1e3a8a;
        color: #ffffff;
      }
      .primary-button:hover {
        background: linear-gradient(180deg, #1e40af, #1e3a8a);
        border-color: #1e3a8a;
      }
      .primary-button strong { font-weight: 800; }
      input, select {
        padding: 8px 10px;
        margin-right: 8px;
        border: 1px solid #c7ced9;
        border-radius: 8px;
        background: #fff;
      }
      .banner { border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; font-size: 14px; }
      .banner.ok { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
      .banner.error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; border-bottom: 1px solid #e5e7eb; padding: 8px; font-size: 14px; }
      .muted { color: var(--ink-500); }
      .status { font-weight: 600; }
      .ok { color: #047857; }
      .warn { color: #b45309; }
      .error { color: #b91c1c; }
      code { background: #eef2ff; padding: 2px 6px; border-radius: 4px; }
      pre { background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 12px; overflow: auto; font-size: 12px; }
      .row { margin-top: 10px; }
      .inline-controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .inline-controls button,
      .inline-controls input,
      .inline-controls select,
      .inline-controls textarea { margin-right: 0; }
      .connection-actions { gap: 10px; align-items: stretch; }
      .connection-actions button { min-height: 38px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; }
      .connection-actions-note { margin: 8px 0 0; display: block; }
      .small-button { padding: 5px 9px; font-size: 12px; }
      .small-select { padding: 4px 8px; font-size: 12px; }
      textarea { padding: 8px 10px; border: 1px solid #c7ced9; border-radius: 8px; font-family: inherit; background: #fff; }
      .table-meta { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin-top: 10px; margin-bottom: 8px; }
      .table-meta p { margin: 0; }
      .search-input { min-width: 260px; }
      .table-scroll { overflow: auto; border: 1px solid #e5e7eb; border-radius: 8px; }
      .table-scroll table { min-width: 1080px; }
      .table-scroll thead th { position: sticky; top: 0; background: #f8fafc; z-index: 1; }
      .settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; margin-top: 10px; }
      .settings-panel { border: 1px solid var(--line); border-radius: 12px; padding: 12px; background: var(--surface-soft); }
      .settings-panel .section-subtitle { margin-top: 0; }
      .settings-intro { margin: 0 0 10px; font-size: 13px; }
      .profile-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
      .profile-grid label { display: block; font-size: 12px; color: var(--ink-600); font-weight: 700; margin-bottom: 4px; }
      .profile-grid input, .profile-grid select { width: 100%; margin-right: 0; box-sizing: border-box; }
      .checkbox-field { display: flex; align-items: center; gap: 8px; min-height: 38px; }
      .checkbox-field input[type="checkbox"] { width: auto; margin: 0; padding: 0; }
      .checkbox-field label { margin: 0; font-size: 13px; color: var(--ink-700); font-weight: 700; }
      .profile-actions { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .profile-status { margin-top: 8px; }
      .section-subtitle { margin: 12px 0 8px; font-size: 15px; color: var(--ink-900); }
      .section-divider { border: 0; border-top: 1px solid #e5e7eb; margin: 16px 0; }
      .overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 10px; }
      .overview-stat { border: 1px solid var(--line); border-radius: 10px; padding: 10px; background: var(--surface-soft); }
      .overview-label { font-size: 12px; color: var(--ink-500); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
      .overview-value { margin-top: 6px; font-size: 20px; font-weight: 800; color: var(--ink-900); line-height: 1.1; }
      .advanced-summary { cursor: pointer; font-weight: 700; color: var(--ink-900); }
      details .advanced-content { margin-top: 12px; }
      .brand-preview { display: block; height: 34px; width: auto; max-width: 260px; border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 4px 8px; }
      .brand-status { margin-top: 10px; }
      .site-footer { margin-top: 16px; padding-top: 10px; border-top: 1px solid var(--line); text-align: center; }
      .copyright { margin: 0; font-size: 12px; color: var(--ink-600); font-weight: 600; }
      .powered-by { margin: 4px 0 0; font-size: 12px; color: var(--ink-500); }
      .powered-by.hidden { display: none; }
      .workspace-nav { display: grid; gap: 6px; margin-top: 10px; }
      .workspace-nav-button {
        width: 100%;
        text-align: left;
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #fff;
        color: var(--ink-700);
        font-size: 13px;
        font-weight: 700;
        margin-right: 0;
      }
      .workspace-nav-button.active { background: #e7f2ff; border-color: #a9c9eb; color: var(--brand-strong); }
      .sidebar-actions .workspace-nav-button { text-align: center; }
      .workspace-grid { margin-top: 12px; display: grid; grid-template-columns: repeat(3, minmax(240px, 1fr)); gap: 10px; }
      .workspace-card { border: 1px solid var(--line); border-radius: 12px; background: var(--surface-soft); padding: 12px; display: grid; gap: 8px; }
      .workspace-card h3 { margin: 0; font-size: 15px; color: var(--ink-900); }
      .workspace-card p { margin: 0; font-size: 13px; color: var(--ink-600); line-height: 1.35; }
      .workspace-inline-search { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .workspace-inline-search input {
        flex: 1;
        min-width: 165px;
        width: 100%;
        margin-right: 0;
        padding: 7px 10px;
      }
      .workspace-inline-search button { margin-right: 0; }
      .workspace-quick-summary { margin: 0; font-size: 12px; color: var(--ink-500); }
      .workspace-card-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 6px;
      }
      .workspace-card-list li {
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #fff;
        padding: 8px 9px;
      }
      .workspace-detail-line {
        margin: 0;
        font-size: 12px;
        color: var(--ink-600);
        line-height: 1.35;
      }
      .workspace-detail-line strong {
        color: var(--ink-700);
      }
      .workspace-client-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        align-items: center;
      }
      .workspace-client-name {
        margin: 0;
        font-size: 13px;
        font-weight: 700;
        color: var(--ink-700);
      }
      .workspace-client-meta {
        margin: 2px 0 0;
        font-size: 12px;
        color: var(--ink-500);
      }
      .workspace-client-state {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid transparent;
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .workspace-client-state.ok {
        color: #0c6f3f;
        border-color: #76c69f;
        background: #e8f8ef;
      }
      .workspace-client-state.warn {
        color: #8f5208;
        border-color: #f0c78a;
        background: #fff4e3;
      }
      .workspace-client-state.error {
        color: #98303f;
        border-color: #f2afb8;
        background: #fff0f3;
      }
      .workspace-hints.hidden { display: none; }
      .hint-grid {
        margin-top: 8px;
        display: grid;
        gap: 8px;
      }
      .hint-card {
        border-radius: 10px;
        border: 1px solid var(--line);
        background: #fff;
        padding: 10px;
      }
      .hint-card.warn { border-left: 4px solid var(--warn); }
      .hint-card.info { border-left: 4px solid var(--brand); }
      .hint-title { margin: 0; font-size: 14px; font-weight: 800; color: var(--ink-700); }
      .hint-detail { margin: 4px 0 0; font-size: 13px; color: var(--ink-600); }
      .hint-action-link {
        display: inline-flex;
        margin-top: 8px;
        font-size: 13px;
        font-weight: 700;
        color: var(--brand-strong);
        text-decoration: none;
        border-bottom: 1px solid transparent;
      }
      .hint-action-link:hover {
        border-color: var(--brand-strong);
      }
      .workspace-card .card-actions { margin-top: 10px; }
      .panel-store { display: none; }
      .panel-modal { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.5); display: grid; place-items: center; padding: 16px; z-index: 1200; }
      .panel-modal.hidden { display: none; }
      .panel-modal-dialog { width: min(1200px, 96vw); max-height: 92vh; background: #ffffff; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; display: grid; grid-template-rows: auto 1fr; }
      .panel-modal-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--line); background: #f6f9ff; }
      .panel-modal-title { margin: 0; font-size: 20px; color: var(--ink-900); }
      .panel-modal-body { overflow: auto; padding: 14px; }
      .panel-content { margin: 0; border: 0; border-radius: 0; padding: 0; box-shadow: none; }
      @media (max-width: 1400px) {
        .workspace-grid { grid-template-columns: repeat(2, minmax(240px, 1fr)); }
      }
      @media (max-width: 1080px) {
        .portal-shell { grid-template-columns: 1fr; }
        .portal-sidebar { border-right: 0; border-bottom: 1px solid var(--line); }
        .portal-main-header { grid-template-columns: 1fr; }
      }
      @media (max-width: 760px) {
        .workspace-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="portal-shell">
      <aside class="portal-sidebar">
        <header class="portal-brand-header">
          <h1 class="portal-page-title">Advisor Portal</h1>
          <img
            id="portalBrandLogo"
            class="portal-brand-logo"
            src="${escapeHtml(DEFAULT_BRAND_LOGO_DATA_URI)}"
            data-default-logo="${escapeHtml(DEFAULT_BRAND_LOGO_DATA_URI)}"
            alt="LetsConnect.ai logo"
          />
        </header>
        <p class="sidebar-note">Select an area to open full controls.</p>
        <div class="workspace-nav" id="workspaceNav">
          <button type="button" class="workspace-nav-button" data-panel="connections">Connections</button>
          <button type="button" class="workspace-nav-button" data-panel="clients">Clients &amp; Access</button>
          <button type="button" class="workspace-nav-button" data-panel="settings">Profile &amp; AI</button>
          <button type="button" class="workspace-nav-button" data-panel="branding">Branding</button>
          <button type="button" class="workspace-nav-button" data-panel="usage">Usage &amp; Billing</button>
          <button type="button" class="workspace-nav-button" data-panel="debug">Diagnostics</button>
        </div>
        <div class="sidebar-actions">
          <button id="logout" type="button" class="workspace-nav-button">Logout</button>
        </div>
      </aside>

      <main class="portal-main">
    <header class="card portal-main-header">
      <div>
        <h1 id="advisorHeaderName" class="advisor-header-title">Advisor</h1>
        <p id="advisorHeaderMeta" class="advisor-header-meta">Loading advisor profile…</p>
      </div>
      <div class="portal-main-actions">
        <button id="openAdvisorCalendarViewTop" type="button" class="primary-button"><strong>Open Advisor Calendar</strong></button>
        <button id="refreshPortalDataTop" type="button">Refresh Data</button>
      </div>
    </header>

    <section id="workspaceHintsCard" class="card workspace-hints hidden">
      <h2 style="margin-top:0;">Setup Hints</h2>
      <p class="muted">Complete these items to enable full scheduling behavior.</p>
      <div id="workspaceHintsGrid" class="hint-grid"></div>
    </section>

    <div class="card">
      <h2 style="margin-top:0;">Overview</h2>
      <p class="muted">Portal health and usage snapshot. Open any workspace area below to edit or inspect details.</p>
      <div class="overview-grid">
        <div class="overview-stat">
          <div class="overview-label">Connected Calendars</div>
          <div id="overviewConnectedCalendars" class="overview-value">0</div>
        </div>
        <div class="overview-stat">
          <div class="overview-label">Total Clients</div>
          <div id="overviewTotalClients" class="overview-value">0</div>
        </div>
        <div class="overview-stat">
          <div class="overview-label">Active Clients</div>
          <div id="overviewActiveClients" class="overview-value">0</div>
        </div>
        <div class="overview-stat">
          <div class="overview-label">Blocked Clients</div>
          <div id="overviewBlockedClients" class="overview-value">0</div>
        </div>
        <div class="overview-stat">
          <div class="overview-label">Email Uses</div>
          <div id="overviewEmailUses" class="overview-value">0</div>
        </div>
        <div class="overview-stat">
          <div class="overview-label">Web Uses</div>
          <div id="overviewWebUses" class="overview-value">0</div>
        </div>
        <div class="overview-stat">
          <div class="overview-label">Total Interactions</div>
          <div id="overviewTotalInteractions" class="overview-value">0</div>
        </div>
      </div>
      <div class="overview-grid">
        <div class="overview-stat">
          <div class="overview-label">LLM Requests</div>
          <div id="overviewLlmRequests" class="overview-value">0</div>
        </div>
        <div class="overview-stat">
          <div class="overview-label">LLM Tokens</div>
          <div id="overviewLlmTokens" class="overview-value">0</div>
        </div>
        <div class="overview-stat">
          <div class="overview-label">Email Sends</div>
          <div id="overviewEmailSends" class="overview-value">0</div>
        </div>
        <div class="overview-stat">
          <div class="overview-label">Calendar API Calls</div>
          <div id="overviewCalendarApiCalls" class="overview-value">0</div>
        </div>
        <div class="overview-stat">
          <div class="overview-label">Invocations</div>
          <div id="overviewInvocations" class="overview-value">0</div>
        </div>
        <div class="overview-stat">
          <div class="overview-label">Estimated Total Cost (USD)</div>
          <div id="overviewEstimatedCost" class="overview-value">$0.0000</div>
        </div>
      </div>
      <p id="overviewUsageHint" class="muted">Usage and billing metrics are loading.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0;">Workspace</h2>
      <p class="muted">Select an area to open full controls in a focused panel.</p>
      <div class="workspace-grid">
        <article class="workspace-card">
          <h3>Connections</h3>
          <p id="workspaceConnectionsSummary">No connections loaded.</p>
          <ul id="workspaceConnectionsDetailList" class="workspace-card-list">
            <li class="muted">No connection details yet.</li>
          </ul>
          <div class="card-actions"><button type="button" class="small-button" data-open-panel="connections">Open</button></div>
        </article>
        <article class="workspace-card">
          <h3>Clients &amp; Access</h3>
          <p id="workspaceClientsSummary">No clients loaded.</p>
          <div class="workspace-inline-search">
            <input
              id="workspaceClientQuickSearch"
              type="search"
              placeholder="Quick search clients..."
              aria-label="Quick search clients"
            />
            <button id="workspaceClientQuickSearchClear" type="button" class="small-button">Clear</button>
          </div>
          <p id="workspaceClientQuickSummary" class="workspace-quick-summary">Top clients will appear here.</p>
          <ul id="workspaceClientQuickList" class="workspace-card-list">
            <li class="muted">No clients loaded.</li>
          </ul>
          <div class="card-actions"><button type="button" class="small-button" data-open-panel="clients">Open</button></div>
        </article>
        <article class="workspace-card">
          <h3>Profile &amp; AI Settings</h3>
          <p id="workspaceSettingsSummary">Advisor profile loading.</p>
          <ul id="workspaceSettingsDetailList" class="workspace-card-list">
            <li class="muted">Advisor profile details are loading.</li>
          </ul>
          <div class="card-actions"><button type="button" class="small-button" data-open-panel="settings">Open</button></div>
        </article>
        <article class="workspace-card">
          <h3>Branding</h3>
          <p id="workspaceBrandingSummary">LetsConnect default branding.</p>
          <ul id="workspaceBrandingDetailList" class="workspace-card-list">
            <li class="muted">Branding details are loading.</li>
          </ul>
          <div class="card-actions"><button type="button" class="small-button" data-open-panel="branding">Open</button></div>
        </article>
        <article class="workspace-card">
          <h3>Usage &amp; Billing</h3>
          <p id="workspaceUsageSummary">Usage metrics loading.</p>
          <ul id="workspaceUsageDetailList" class="workspace-card-list">
            <li class="muted">Usage details are loading.</li>
          </ul>
          <div class="card-actions"><button type="button" class="small-button" data-open-panel="usage">Open</button></div>
        </article>
        <article class="workspace-card">
          <h3>Diagnostics</h3>
          <p id="workspaceDebugSummary">No trace selected.</p>
          <ul id="workspaceDebugDetailList" class="workspace-card-list">
            <li class="muted">Diagnostics details appear after trace lookup.</li>
          </ul>
          <div class="card-actions"><button type="button" class="small-button" data-open-panel="debug">Open</button></div>
        </article>
      </div>
    </div>

    <div id="detailPanelStore" class="panel-store">
      <section class="card panel-content" data-panel-id="connections" data-panel-title="Connected Calendars">
        <h2 style="margin-top:0;">Connected Calendars</h2>
        <div id="statusBanner" style="display:none"></div>
        <p class="muted">Add calendars for availability checks without manually editing AWS secrets, then manage them below.</p>
        <div class="row inline-controls connection-actions">
          <button id="googleConnect">Connect Google (Sign In)</button>
          <button id="microsoftConnect">Connect Microsoft (Sign In)</button>
          <button id="openAdvisorCalendarView">Open Advisor Calendar</button>
          <button id="refreshPortalData">Refresh Data</button>
        </div>
        <p class="muted connection-actions-note">Google/Microsoft flows require app credentials configured in backend secrets.</p>
        <h3 class="section-subtitle">Current Connections</h3>
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
      </section>

      <section class="card panel-content" data-panel-id="clients" data-panel-title="Clients &amp; Access">
        <h2 style="margin-top:0;">Clients &amp; Access</h2>
        <p class="muted">Manage client cohorts, access policies, and admission allowlist from one place.</p>
        <h3 class="section-subtitle">Access Policies</h3>
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

        <hr class="section-divider" />

        <h3 class="section-subtitle">Client Directory</h3>
        <p class="muted">Metadata-only client list with first contact, usage counters, and access policy controls.</p>
        <div class="row inline-controls">
          <input id="newClientEmail" placeholder="client email (example: client@example.com)" style="min-width: 260px;" />
          <input id="newClientDisplayName" placeholder="display name (optional)" style="min-width: 200px;" />
          <select id="newClientPolicy" class="small-select"></select>
          <button id="addClient">Add Client</button>
        </div>
        <div class="row inline-controls">
          <textarea id="bulkClientEmails" rows="4" style="min-width: 520px;" placeholder="Bulk import client emails (one per line)"></textarea>
          <button id="bulkImportClients">Bulk Import</button>
        </div>
        <p id="clientImportStatus" class="muted">Add one client or bulk import emails to control who can receive agent responses.</p>
        <div class="table-meta">
          <div class="inline-controls">
            <input id="clientSearchInput" class="search-input" placeholder="Search clients by name or email" />
            <button id="clearClientSearch" class="small-button" type="button">Clear</button>
          </div>
          <p id="clientListSummary" class="muted">Showing 0 of 0 clients.</p>
        </div>
        <div class="table-scroll">
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
      </section>

      <section class="card panel-content" data-panel-id="settings" data-panel-title="Advisor Profile &amp; AI Settings">
        <h2 style="margin-top:0;">Advisor Profile &amp; AI Settings</h2>
        <p class="muted">Defaults are initialized from advisor Google login and can be edited here.</p>
        <div class="settings-grid">
          <section class="settings-panel">
            <h3 class="section-subtitle">Advisor Identity</h3>
            <p class="muted settings-intro">Email identity and timezone used in outbound responses and calendar suggestions.</p>
            <div class="profile-grid">
              <div>
                <label for="advisorAgentEmail">Agent Email</label>
                <input id="advisorAgentEmail" type="email" placeholder="advisor.agent@agent.letsconnect.ai" />
              </div>
              <div>
                <label for="advisorInviteEmail">Advisor Invite Email</label>
                <input id="advisorInviteEmail" type="email" placeholder="advisor@example.com" />
              </div>
              <div>
                <label for="advisorPreferredName">Preferred Name</label>
                <input id="advisorPreferredName" type="text" placeholder="Advisor name" maxlength="64" />
              </div>
              <div>
                <label for="advisorTimezone">Advisor Timezone</label>
                <input id="advisorTimezone" type="text" placeholder="America/Los_Angeles" />
              </div>
            </div>
          </section>
          <section class="settings-panel">
            <h3 class="section-subtitle">AI Settings</h3>
            <p class="muted settings-intro">Provider/model and advisor-managed key controls for email response generation.</p>
            <div class="profile-grid">
              <div>
                <label for="advisorLlmKeyMode">LLM Key Source</label>
                <select id="advisorLlmKeyMode">
                  <option value="platform">Platform Default Key</option>
                  <option value="advisor">Advisor Key</option>
                </select>
              </div>
              <div>
                <label for="advisorLlmProvider">LLM Provider</label>
                <select id="advisorLlmProvider">
                  <option value="openai">OpenAI</option>
                </select>
              </div>
              <div>
                <label for="advisorLlmModel">LLM Model</label>
                <input id="advisorLlmModel" type="text" placeholder="gpt-5.2" maxlength="80" />
              </div>
              <div>
                <label for="advisorLlmEndpoint">LLM Endpoint</label>
                <input id="advisorLlmEndpoint" type="url" placeholder="https://api.openai.com/v1/chat/completions" />
              </div>
              <div>
                <label for="advisorLlmApiKey">Advisor LLM API Key (optional)</label>
                <input id="advisorLlmApiKey" type="password" placeholder="sk-..." autocomplete="off" />
              </div>
              <div class="checkbox-field">
                <input id="clearAdvisorLlmApiKey" type="checkbox" />
                <label for="clearAdvisorLlmApiKey">Clear stored advisor key when saving</label>
              </div>
            </div>
          </section>
        </div>
        <div class="profile-actions">
          <button id="saveAdvisorSettings">Save Profile</button>
        </div>
        <p id="advisorSettingsStatus" class="muted profile-status">Loading advisor profile settings...</p>
      </section>

      <section class="card panel-content" data-panel-id="branding" data-panel-title="Branding">
        <h2 style="margin-top:0;">Branding</h2>
        <p class="muted">Default letsconnect.ai logo is shown unless you upload an advisor logo.</p>
        <div class="row inline-controls">
          <img
            id="brandLogoPreview"
            class="brand-preview"
            src="${escapeHtml(DEFAULT_BRAND_LOGO_DATA_URI)}"
            data-default-logo="${escapeHtml(DEFAULT_BRAND_LOGO_DATA_URI)}"
            alt="Current brand logo preview"
          />
          <input id="brandLogoFile" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" />
          <button id="saveBrandLogo">Use Uploaded Logo</button>
          <button id="resetBrandLogo">Use LetsConnect Logo</button>
        </div>
        <p id="brandStatus" class="muted brand-status">Current branding: LetsConnect.ai default.</p>
        <p class="muted">Local preview mode: uploaded logo is stored in this browser only for now.</p>
      </section>

      <section class="card panel-content" data-panel-id="usage" data-panel-title="Usage &amp; Billing">
        <h2 style="margin-top:0;">Usage &amp; Billing</h2>
        <p class="muted">Model usage, token counts, and estimated costs across the selected time window.</p>
        <div class="row inline-controls">
          <label for="usageWindowSelect" class="muted">Usage Window</label>
          <select id="usageWindowSelect">
            <option value="daily">Daily (24h)</option>
            <option value="weekly" selected>Weekly (7d)</option>
            <option value="monthly">Monthly (30d)</option>
          </select>
          <button id="refreshUsageSummary">Refresh Usage</button>
        </div>
        <h3 class="section-subtitle">LLM Usage By Model</h3>
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Model</th>
              <th>Requests</th>
              <th>Input Tokens</th>
              <th>Output Tokens</th>
              <th>Total Tokens</th>
              <th>Estimated Cost (USD)</th>
            </tr>
          </thead>
          <tbody id="usageByModelBody">
            <tr><td colspan="7" class="muted">Loading usage metrics...</td></tr>
          </tbody>
        </table>
      </section>

      <section class="card panel-content" data-panel-id="debug" data-panel-title="Diagnostics">
        <h2 style="margin-top:0;">Diagnostics</h2>
        <p class="muted">Metadata-only trace lookup and feedback workflow for support and root-cause analysis.</p>
        <div class="row">
          <input id="traceRequestId" placeholder="requestId (UUID)" style="min-width: 320px;" />
          <button id="traceLookup">Lookup Trace</button>
        </div>
        <div class="row inline-controls">
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
      </section>
    </div>

    <footer class="site-footer">
      <p class="copyright">${escapeHtml(BRAND_COPYRIGHT_NOTICE)}</p>
      <p id="portalPoweredBy" class="powered-by hidden">${escapeHtml(BRAND_POWERED_BY_NOTICE)}</p>
    </footer>
      </main>
    </div>

    <div id="panelModal" class="panel-modal hidden" role="dialog" aria-modal="true" aria-labelledby="panelModalTitle">
      <div class="panel-modal-dialog">
        <header class="panel-modal-header">
          <h2 id="panelModalTitle" class="panel-modal-title">Workspace Panel</h2>
          <button id="panelModalClose" type="button" class="small-button">Close</button>
        </header>
        <div id="panelModalBody" class="panel-modal-body"></div>
      </div>
    </div>

    <script>
      let lastTrace = null;
      let policyOptions = ['default', 'weekend', 'monday'];
      let latestPolicies = [];
      let latestConnections = [];
      let latestClients = [];
      let latestClientPolicyOptions = ['default', 'weekend', 'monday'];
      let clientSearchQuery = '';
      let workspaceClientQuickQuery = '';
      let latestUsageSummary = null;
      let latestAdvisorSettings = null;
      let selectedUsageWindow = 'weekly';
      let activePanelNode = null;
      const BRAND_STORAGE_KEY = '${BRAND_STORAGE_KEY}';
      const BRAND_MAX_BYTES = 1024 * 1024;

      function getStoredBrandLogo() {
        try {
          return String(localStorage.getItem(BRAND_STORAGE_KEY) || '');
        } catch (_error) {
          return '';
        }
      }

      function removeStoredBrandLogo() {
        try {
          localStorage.removeItem(BRAND_STORAGE_KEY);
          return true;
        } catch (_error) {
          return false;
        }
      }

      function storeBrandLogo(dataUrl) {
        try {
          localStorage.setItem(BRAND_STORAGE_KEY, dataUrl);
          return true;
        } catch (_error) {
          return false;
        }
      }

      function setBrandStatus(text, cssClass) {
        const node = document.getElementById('brandStatus');
        if (!node) {
          return;
        }
        node.className = 'muted brand-status' + (cssClass ? ' ' + cssClass : '');
        node.textContent = text;
      }

      function setWorkspaceSummary(nodeId, text) {
        const node = document.getElementById(nodeId);
        if (!node) {
          return;
        }
        node.textContent = String(text || '');
      }

      function renderWorkspaceDetailList(nodeId, lines, emptyMessage) {
        const node = document.getElementById(nodeId);
        if (!node) {
          return;
        }

        node.innerHTML = '';
        const normalizedLines = Array.isArray(lines)
          ? lines
              .map((line) => String(line || '').trim())
              .filter(Boolean)
          : [];

        if (normalizedLines.length === 0) {
          const emptyItem = document.createElement('li');
          emptyItem.className = 'muted';
          emptyItem.textContent = String(emptyMessage || 'No details available.');
          node.appendChild(emptyItem);
          return;
        }

        for (const line of normalizedLines) {
          const item = document.createElement('li');
          const paragraph = document.createElement('p');
          paragraph.className = 'workspace-detail-line';
          paragraph.textContent = line;
          item.appendChild(paragraph);
          node.appendChild(item);
        }
      }

      function compactWorkspaceValue(value, maxLength = 48) {
        const normalized = String(value || '').trim();
        if (normalized.length <= maxLength) {
          return normalized;
        }
        return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…';
      }

      function setWorkspaceNavActive(panelId) {
        const buttons = Array.from(document.querySelectorAll('#workspaceNav [data-panel]'));
        for (const button of buttons) {
          const isActive = String(button.getAttribute('data-panel') || '') === String(panelId || '');
          button.classList.toggle('active', isActive);
        }
      }

      function normalizeClientAccessStateLabel(value) {
        const normalized = String(value || '')
          .trim()
          .toLowerCase();
        if (normalized === 'blocked') {
          return 'blocked';
        }
        if (normalized === 'deleted') {
          return 'deleted';
        }
        return 'active';
      }

      function clientAccessStateClass(accessState) {
        if (accessState === 'blocked') {
          return 'warn';
        }
        if (accessState === 'deleted') {
          return 'error';
        }
        return 'ok';
      }

      function renderWorkspaceClientQuickList() {
        const listNode = document.getElementById('workspaceClientQuickList');
        const summaryNode = document.getElementById('workspaceClientQuickSummary');
        if (!listNode || !summaryNode) {
          return;
        }

        const clients = Array.isArray(latestClients) ? latestClients : [];
        const normalizedSearchQuery = normalizeClientSearchInput(workspaceClientQuickQuery);
        const filteredClients = normalizedSearchQuery
          ? clients.filter((client) => clientMatchesSearch(client, normalizedSearchQuery))
          : clients;
        const visibleClients = filteredClients.slice(0, 3);

        listNode.innerHTML = '';

        if (clients.length === 0) {
          const emptyItem = document.createElement('li');
          emptyItem.className = 'muted';
          emptyItem.textContent = 'No clients imported yet.';
          listNode.appendChild(emptyItem);
          summaryNode.textContent = 'Import clients to start quick search.';
          return;
        }

        if (visibleClients.length === 0) {
          const emptyItem = document.createElement('li');
          emptyItem.className = 'muted';
          emptyItem.textContent = 'No clients match this search.';
          listNode.appendChild(emptyItem);
          summaryNode.textContent = 'No matches found in ' + clients.length + ' clients.';
          return;
        }

        if (normalizedSearchQuery) {
          summaryNode.textContent =
            'Showing ' +
            visibleClients.length +
            ' of ' +
            filteredClients.length +
            ' matches (' +
            clients.length +
            ' total clients).';
        } else {
          summaryNode.textContent = 'Showing ' + visibleClients.length + ' of ' + clients.length + ' recent clients.';
        }

        for (const client of visibleClients) {
          const accessState = normalizeClientAccessStateLabel(client?.accessState);
          const listItem = document.createElement('li');
          const row = document.createElement('div');
          row.className = 'workspace-client-row';

          const details = document.createElement('div');
          const name = document.createElement('p');
          name.className = 'workspace-client-name';
          name.textContent = String(client?.clientDisplayName || 'Client');
          const meta = document.createElement('p');
          meta.className = 'workspace-client-meta';
          meta.textContent = String(client?.clientEmail || client?.clientId || '');
          details.appendChild(name);
          details.appendChild(meta);

          const state = document.createElement('span');
          state.className = 'workspace-client-state ' + clientAccessStateClass(accessState);
          state.textContent = accessState;

          row.appendChild(details);
          row.appendChild(state);
          listItem.appendChild(row);
          listNode.appendChild(listItem);
        }
      }

      function renderWorkspaceHints() {
        const cardNode = document.getElementById('workspaceHintsCard');
        const gridNode = document.getElementById('workspaceHintsGrid');
        if (!cardNode || !gridNode) {
          return;
        }

        const connectedCalendars = latestConnections.filter(
          (connection) => String(connection?.status || '').toLowerCase() === 'connected'
        ).length;
        const totalClients = Array.isArray(latestClients) ? latestClients.length : 0;
        const hints = [];

        if (connectedCalendars === 0) {
          hints.push({
            level: 'warn',
            title: 'Connect your first calendar',
            detail: 'Scheduling responses remain in hold mode until at least one calendar is connected.',
            actionText: 'Connect a calendar now',
            actionPanel: 'connections',
            actionFocus: 'googleConnect'
          });
        }

        if (totalClients === 0) {
          hints.push({
            level: 'info',
            title: 'Import clients to enable replies',
            detail: 'Unknown senders are blackholed by policy until clients are admitted.',
            actionText: 'Import or add clients',
            actionPanel: 'clients',
            actionFocus: 'bulkClientEmails'
          });
        }

        if (hints.length === 0) {
          cardNode.classList.add('hidden');
          gridNode.innerHTML = '';
          return;
        }

        gridNode.innerHTML = '';
        for (const hint of hints) {
          const item = document.createElement('article');
          item.className = 'hint-card ' + hint.level;
          const title = document.createElement('p');
          title.className = 'hint-title';
          title.textContent = hint.title;
          const detail = document.createElement('p');
          detail.className = 'hint-detail';
          detail.textContent = hint.detail;
          item.appendChild(title);
          item.appendChild(detail);
          if (hint.actionText && hint.actionPanel) {
            const actionLink = document.createElement('a');
            actionLink.className = 'hint-action-link';
            actionLink.href = '#';
            actionLink.textContent = hint.actionText;
            actionLink.setAttribute('data-hint-panel', hint.actionPanel);
            actionLink.setAttribute('data-hint-focus', String(hint.actionFocus || ''));
            item.appendChild(actionLink);
          }
          gridNode.appendChild(item);
        }

        cardNode.classList.remove('hidden');
      }

      function updateWorkspaceSummaries() {
        const connectedCalendars = latestConnections.filter((connection) => String(connection?.status || '').toLowerCase() === 'connected').length;
        const erroredConnections = latestConnections.filter((connection) => String(connection?.status || '').toLowerCase() === 'error').length;
        const primaryConnection = latestConnections.find((connection) => Boolean(connection?.isPrimary));
        const totalClients = latestClients.length;
        const blockedClients = latestClients.filter((client) => String(client?.accessState || '').toLowerCase() === 'blocked').length;
        const customPolicies = latestPolicies.filter((policy) => String(policy?.source || '').toLowerCase() === 'custom').length;
        const usageTotals = latestUsageSummary?.totals || {};
        const usageByModel = Array.isArray(latestUsageSummary?.byModel) ? latestUsageSummary.byModel : [];
        const llmRequests = normalizeCount(usageTotals.llmRequestCount);
        const llmTokens = normalizeCount(usageTotals.llmTotalTokens);
        const estimatedCost = formatUsd(usageTotals.estimatedTotalCostUsd);
        const usageWindow = String(latestUsageSummary?.window || selectedUsageWindow || 'weekly').trim().toLowerCase();
        const profileAlias = String(latestAdvisorSettings?.agentEmail || '').trim();
        const inviteEmail = String(latestAdvisorSettings?.inviteEmail || '').trim();
        const advisorTimezone = String(latestAdvisorSettings?.timezone || '').trim();
        const llmProvider = String(latestAdvisorSettings?.llmProvider || 'openai').trim();
        const llmModel = String(latestAdvisorSettings?.llmModel || 'gpt-5.2').trim();
        const llmKeyMode = String(latestAdvisorSettings?.llmKeyMode || 'platform').trim();
        const profileName = String(latestAdvisorSettings?.preferredName || '').trim();
        const storedLogo = getStoredBrandLogo();
        const topUsageModel = usageByModel.length > 0 ? usageByModel[0] : null;
        const usageWindowLabel =
          usageWindow === 'daily'
            ? 'Daily (24h)'
            : usageWindow === 'monthly'
              ? 'Monthly (30d)'
              : 'Weekly (7d)';
        const debugSummary =
          lastTrace && lastTrace.requestId
            ? 'Last trace: ' + String(lastTrace.requestId) + ' (' + String(lastTrace.status || 'unknown') + ')'
            : 'No trace selected.';

        setWorkspaceSummary(
          'workspaceConnectionsSummary',
          connectedCalendars + ' connected' + (erroredConnections > 0 ? ' | ' + erroredConnections + ' needs attention' : '')
        );
        setWorkspaceSummary(
          'workspaceClientsSummary',
          totalClients +
            ' clients' +
            (blockedClients > 0 ? ' | ' + blockedClients + ' blocked' : '') +
            ' | ' +
            latestPolicies.length +
            ' policies' +
            (customPolicies > 0 ? ' (' + customPolicies + ' custom)' : '')
        );
        setWorkspaceSummary(
          'workspaceSettingsSummary',
          profileAlias
            ? (profileName ? profileName + ' | ' : '') + profileAlias
            : 'Advisor profile loading.'
        );
        setWorkspaceSummary(
          'workspaceBrandingSummary',
          storedLogo ? 'Advisor uploaded logo active.' : 'LetsConnect default branding.'
        );
        setWorkspaceSummary(
          'workspaceUsageSummary',
          latestUsageSummary ? llmRequests + ' LLM requests | ' + estimatedCost + ' estimated cost' : 'Usage metrics loading.'
        );
        setWorkspaceSummary(
          'workspaceDebugSummary',
          debugSummary
        );
        renderWorkspaceDetailList(
          'workspaceConnectionsDetailList',
          [
            'Connected: ' + connectedCalendars + ' of ' + latestConnections.length + ' calendars',
            primaryConnection
              ? 'Primary: ' +
                compactWorkspaceValue(String(primaryConnection.provider || 'calendar') + ' · ' + String(primaryConnection.accountEmail || '-'))
              : 'Primary: Not set',
            erroredConnections > 0 ? 'Needs attention: ' + erroredConnections + ' connection(s) in error' : 'Health: All connection statuses are healthy'
          ],
          'No connection details yet.'
        );
        renderWorkspaceDetailList(
          'workspaceSettingsDetailList',
          [
            inviteEmail ? 'Invite email: ' + compactWorkspaceValue(inviteEmail) : 'Invite email: Not configured',
            profileAlias ? 'Agent alias: ' + compactWorkspaceValue(profileAlias) : 'Agent alias: Not configured',
            advisorTimezone ? 'Timezone: ' + advisorTimezone : 'Timezone: America/Los_Angeles',
            'LLM: ' + llmProvider + ' · ' + llmModel + ' (' + llmKeyMode + ' key mode)'
          ],
          'Advisor profile details are loading.'
        );
        renderWorkspaceDetailList(
          'workspaceBrandingDetailList',
          [
            storedLogo ? 'Brand mode: Advisor logo + LetsConnect co-branding' : 'Brand mode: LetsConnect default',
            storedLogo ? 'Footer note: Powered by LetsConnect.ai is visible' : 'Footer note: Powered by line is hidden',
            'Logo source: ' + (storedLogo ? 'Browser-stored advisor upload' : 'System default letsconnect.ai logo')
          ],
          'Branding details are loading.'
        );
        renderWorkspaceDetailList(
          'workspaceUsageDetailList',
          [
            'Window: ' + usageWindowLabel,
            'LLM requests: ' + llmRequests + ' · Tokens: ' + llmTokens,
            'Estimated cost: ' + estimatedCost,
            topUsageModel
              ? 'Top model: ' + compactWorkspaceValue(String(topUsageModel.model || 'unknown')) + ' · ' + formatCount(topUsageModel.requestCount || 0) + ' requests'
              : 'Top model: No model usage yet'
          ],
          'Usage details are loading.'
        );
        renderWorkspaceDetailList(
          'workspaceDebugDetailList',
          lastTrace && lastTrace.requestId
            ? [
                'Request: ' + compactWorkspaceValue(String(lastTrace.requestId), 18),
                'Status: ' + String(lastTrace.status || 'unknown') + ' · LLM: ' + String(lastTrace.llmStatus || 'unknown'),
                'Feedback: ' + String(lastTrace.feedbackType || 'none') + (lastTrace.feedbackReason ? ' (' + String(lastTrace.feedbackReason) + ')' : '')
              ]
            : [
                'No trace selected yet.',
                'Use request ID lookup in Diagnostics.',
                'Feedback actions appear after a trace is loaded.'
              ],
          'Diagnostics details appear after trace lookup.'
        );
        renderWorkspaceClientQuickList();
      }

      function closePanelModal() {
        const modal = document.getElementById('panelModal');
        const panelStore = document.getElementById('detailPanelStore');
        const modalBody = document.getElementById('panelModalBody');
        if (!modal || !panelStore || !modalBody) {
          return;
        }

        if (activePanelNode) {
          panelStore.appendChild(activePanelNode);
          activePanelNode = null;
        }

        modal.classList.add('hidden');
        modalBody.innerHTML = '';
        setWorkspaceNavActive('');
      }

      function openPanel(panelId) {
        const normalizedPanelId = String(panelId || '').trim();
        if (!normalizedPanelId) {
          return;
        }

        const panelStore = document.getElementById('detailPanelStore');
        const modal = document.getElementById('panelModal');
        const modalBody = document.getElementById('panelModalBody');
        const modalTitle = document.getElementById('panelModalTitle');
        if (!panelStore || !modal || !modalBody || !modalTitle) {
          return;
        }

        const panelNode = panelStore.querySelector('[data-panel-id="' + normalizedPanelId + '"]');
        if (!panelNode) {
          return;
        }

        if (activePanelNode && activePanelNode !== panelNode) {
          panelStore.appendChild(activePanelNode);
          activePanelNode = null;
        }

        const title = String(panelNode.getAttribute('data-panel-title') || 'Workspace Panel');
        modalTitle.textContent = title;
        modalBody.innerHTML = '';
        modalBody.appendChild(panelNode);
        activePanelNode = panelNode;
        modal.classList.remove('hidden');
        setWorkspaceNavActive(normalizedPanelId);
      }

      function openPanelAndFocus(panelId, focusElementId) {
        openPanel(panelId);
        const normalizedFocusElementId = String(focusElementId || '').trim();
        if (!normalizedFocusElementId) {
          return;
        }

        window.setTimeout(() => {
          const node = document.getElementById(normalizedFocusElementId);
          if (!node || typeof node.focus !== 'function') {
            return;
          }
          node.focus();
        }, 0);
      }

      function bindWorkspacePanelInteractions() {
        const navButtons = Array.from(document.querySelectorAll('#workspaceNav [data-panel]'));
        for (const button of navButtons) {
          button.addEventListener('click', () => {
            openPanel(button.getAttribute('data-panel'));
          });
        }

        const cardButtons = Array.from(document.querySelectorAll('[data-open-panel]'));
        for (const button of cardButtons) {
          button.addEventListener('click', () => {
            openPanel(button.getAttribute('data-open-panel'));
          });
        }

        const hintGrid = document.getElementById('workspaceHintsGrid');
        if (hintGrid) {
          hintGrid.addEventListener('click', (event) => {
            const link = event.target?.closest?.('[data-hint-panel]');
            if (!link) {
              return;
            }
            event.preventDefault();
            openPanelAndFocus(link.getAttribute('data-hint-panel'), link.getAttribute('data-hint-focus'));
          });
        }

        const modal = document.getElementById('panelModal');
        const closeButton = document.getElementById('panelModalClose');
        if (closeButton) {
          closeButton.addEventListener('click', () => {
            closePanelModal();
          });
        }
        if (modal) {
          modal.addEventListener('click', (event) => {
            if (event.target === modal) {
              closePanelModal();
            }
          });
        }
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            closePanelModal();
          }
        });
      }

      function applyPortalBranding() {
        const portalLogo = document.getElementById('portalBrandLogo');
        const previewLogo = document.getElementById('brandLogoPreview');
        const poweredBy = document.getElementById('portalPoweredBy');
        const storedLogo = getStoredBrandLogo();
        const defaultLogo =
          (portalLogo && portalLogo.getAttribute('data-default-logo')) ||
          (previewLogo && previewLogo.getAttribute('data-default-logo')) ||
          '';
        const effectiveLogo = storedLogo || defaultLogo;

        if (portalLogo && effectiveLogo) {
          portalLogo.setAttribute('src', effectiveLogo);
        }
        if (previewLogo && effectiveLogo) {
          previewLogo.setAttribute('src', effectiveLogo);
        }
        if (poweredBy) {
          poweredBy.classList.toggle('hidden', !storedLogo);
        }

        if (storedLogo) {
          setBrandStatus('Current branding: advisor uploaded logo active.', 'ok');
        } else {
          setBrandStatus('Current branding: LetsConnect.ai default.');
        }
        updateWorkspaceSummaries();
      }

      function setAdvisorSettingsStatus(text, cssClass) {
        const node = document.getElementById('advisorSettingsStatus');
        if (!node) {
          return;
        }
        node.className = 'muted profile-status' + (cssClass ? ' ' + cssClass : '');
        node.textContent = text;
      }

      function deriveAdvisorHeaderName(settings) {
        const preferredName = String(settings?.preferredName || '').trim();
        if (preferredName) {
          return preferredName;
        }

        const inviteEmail = String(settings?.inviteEmail || settings?.advisorEmail || '').trim();
        if (inviteEmail.includes('@')) {
          return inviteEmail.split('@')[0];
        }

        return 'Advisor';
      }

      function updateAdvisorHeader(settings = latestAdvisorSettings) {
        const titleNode = document.getElementById('advisorHeaderName');
        const metaNode = document.getElementById('advisorHeaderMeta');
        if (!titleNode || !metaNode) {
          return;
        }

        const resolvedSettings = settings || {};
        titleNode.textContent = deriveAdvisorHeaderName(resolvedSettings);

        const metaParts = [];
        const inviteEmail = String(resolvedSettings.inviteEmail || '').trim();
        const timezone = String(resolvedSettings.timezone || '').trim();
        const agentEmail = String(resolvedSettings.agentEmail || '').trim();
        if (inviteEmail) {
          metaParts.push(inviteEmail);
        }
        if (timezone) {
          metaParts.push(timezone);
        }
        if (agentEmail) {
          metaParts.push(agentEmail);
        }

        metaNode.textContent = metaParts.length > 0 ? metaParts.join(' | ') : 'Loading advisor profile...';
      }

      function readAdvisorSettingsInputs() {
        const payload = {
          agentEmail: String(document.getElementById('advisorAgentEmail')?.value || '').trim(),
          inviteEmail: String(document.getElementById('advisorInviteEmail')?.value || '').trim(),
          preferredName: String(document.getElementById('advisorPreferredName')?.value || '').trim(),
          timezone: String(document.getElementById('advisorTimezone')?.value || '').trim(),
          llmKeyMode: String(document.getElementById('advisorLlmKeyMode')?.value || '').trim(),
          llmProvider: String(document.getElementById('advisorLlmProvider')?.value || '').trim(),
          llmModel: String(document.getElementById('advisorLlmModel')?.value || '').trim(),
          llmEndpoint: String(document.getElementById('advisorLlmEndpoint')?.value || '').trim()
        };

        const llmApiKey = String(document.getElementById('advisorLlmApiKey')?.value || '').trim();
        if (llmApiKey) {
          payload.llmApiKey = llmApiKey;
        }

        const clearAdvisorLlmApiKey = Boolean(document.getElementById('clearAdvisorLlmApiKey')?.checked);
        if (clearAdvisorLlmApiKey) {
          payload.clearAdvisorLlmApiKey = true;
        }

        return payload;
      }

      async function loadAdvisorSettings() {
        setAdvisorSettingsStatus('Loading advisor profile settings...');
        const response = await fetch('./advisor/api/settings');
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Unable to load advisor settings.');
        }

        const settings = payload.settings || {};
        latestAdvisorSettings = settings;
        updateAdvisorHeader(settings);
        const agentEmailInput = document.getElementById('advisorAgentEmail');
        const inviteEmailInput = document.getElementById('advisorInviteEmail');
        const preferredNameInput = document.getElementById('advisorPreferredName');
        const timezoneInput = document.getElementById('advisorTimezone');
        const llmKeyModeInput = document.getElementById('advisorLlmKeyMode');
        const llmProviderInput = document.getElementById('advisorLlmProvider');
        const llmModelInput = document.getElementById('advisorLlmModel');
        const llmEndpointInput = document.getElementById('advisorLlmEndpoint');
        const llmApiKeyInput = document.getElementById('advisorLlmApiKey');
        const clearLlmApiKeyInput = document.getElementById('clearAdvisorLlmApiKey');

        if (agentEmailInput) {
          agentEmailInput.value = settings.agentEmail || '';
        }
        if (inviteEmailInput) {
          inviteEmailInput.value = settings.inviteEmail || '';
        }
        if (preferredNameInput) {
          preferredNameInput.value = settings.preferredName || '';
        }
        if (timezoneInput) {
          timezoneInput.value = settings.timezone || 'America/Los_Angeles';
        }
        if (llmKeyModeInput) {
          llmKeyModeInput.value = settings.llmKeyMode || 'platform';
        }
        if (llmProviderInput) {
          llmProviderInput.value = settings.llmProvider || 'openai';
        }
        if (llmModelInput) {
          llmModelInput.value = settings.llmModel || 'gpt-5.2';
        }
        if (llmEndpointInput) {
          llmEndpointInput.value = settings.llmEndpoint || 'https://api.openai.com/v1/chat/completions';
        }
        if (llmApiKeyInput) {
          llmApiKeyInput.value = '';
        }
        if (clearLlmApiKeyInput) {
          clearLlmApiKeyInput.checked = false;
        }

        const configuredMessage = settings.advisorLlmKeyConfigured
          ? 'Advisor LLM key is configured.'
          : 'Advisor LLM key is not configured.';
        setAdvisorSettingsStatus('Advisor profile loaded. ' + configuredMessage, 'ok');
        updateWorkspaceSummaries();
      }

      async function saveAdvisorSettings() {
        const payload = readAdvisorSettingsInputs();
        setAdvisorSettingsStatus('Saving advisor profile settings...');
        const response = await fetch('./advisor/api/settings', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const responsePayload = await response.json();
        if (!response.ok) {
          throw new Error(responsePayload.error || 'Unable to save advisor settings.');
        }

        const updated = responsePayload.settings || {};
        latestAdvisorSettings = updated;
        updateAdvisorHeader(updated);
        const agentEmailInput = document.getElementById('advisorAgentEmail');
        const inviteEmailInput = document.getElementById('advisorInviteEmail');
        const preferredNameInput = document.getElementById('advisorPreferredName');
        const timezoneInput = document.getElementById('advisorTimezone');
        const llmKeyModeInput = document.getElementById('advisorLlmKeyMode');
        const llmProviderInput = document.getElementById('advisorLlmProvider');
        const llmModelInput = document.getElementById('advisorLlmModel');
        const llmEndpointInput = document.getElementById('advisorLlmEndpoint');
        const llmApiKeyInput = document.getElementById('advisorLlmApiKey');
        const clearLlmApiKeyInput = document.getElementById('clearAdvisorLlmApiKey');

        if (agentEmailInput) {
          agentEmailInput.value = updated.agentEmail || '';
        }
        if (inviteEmailInput) {
          inviteEmailInput.value = updated.inviteEmail || '';
        }
        if (preferredNameInput) {
          preferredNameInput.value = updated.preferredName || '';
        }
        if (timezoneInput) {
          timezoneInput.value = updated.timezone || 'America/Los_Angeles';
        }
        if (llmKeyModeInput) {
          llmKeyModeInput.value = updated.llmKeyMode || 'platform';
        }
        if (llmProviderInput) {
          llmProviderInput.value = updated.llmProvider || 'openai';
        }
        if (llmModelInput) {
          llmModelInput.value = updated.llmModel || 'gpt-5.2';
        }
        if (llmEndpointInput) {
          llmEndpointInput.value = updated.llmEndpoint || 'https://api.openai.com/v1/chat/completions';
        }
        if (llmApiKeyInput) {
          llmApiKeyInput.value = '';
        }
        if (clearLlmApiKeyInput) {
          clearLlmApiKeyInput.checked = false;
        }

        const configuredMessage = updated.advisorLlmKeyConfigured
          ? 'Advisor LLM key is configured.'
          : 'Advisor LLM key is not configured.';
        setAdvisorSettingsStatus('Advisor profile saved. ' + configuredMessage, 'ok');
        updateWorkspaceSummaries();
      }

      function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('Unable to read selected image.'));
          reader.readAsDataURL(file);
        });
      }

      async function saveUploadedBrandLogo() {
        const input = document.getElementById('brandLogoFile');
        if (!input || !input.files || input.files.length === 0) {
          throw new Error('Select an image file first.');
        }

        const selectedFile = input.files[0];
        if (!String(selectedFile.type || '').startsWith('image/')) {
          throw new Error('Only image files are allowed.');
        }
        if (Number(selectedFile.size || 0) > BRAND_MAX_BYTES) {
          throw new Error('Please use a logo under 1MB.');
        }

        const dataUrl = await readFileAsDataUrl(selectedFile);
        if (!dataUrl.startsWith('data:image/')) {
          throw new Error('Invalid image format.');
        }

        if (!storeBrandLogo(dataUrl)) {
          throw new Error('Unable to save logo in local browser storage.');
        }

        applyPortalBranding();
      }

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
        updateWorkspaceSummaries();
      }

      function setTraceStatus(text, cssClass) {
        const node = document.getElementById('traceStatus');
        node.className = cssClass || 'muted';
        node.textContent = text;
      }

      function setOverviewMetric(nodeId, value) {
        const node = document.getElementById(nodeId);
        if (!node) {
          return;
        }
        node.textContent = String(value);
      }

      function setOverviewText(nodeId, value) {
        const node = document.getElementById(nodeId);
        if (!node) {
          return;
        }
        node.textContent = String(value || '');
      }

      function normalizeCount(value) {
        const parsed = Number(value || 0);
        if (!Number.isFinite(parsed)) {
          return 0;
        }
        return Math.max(0, Math.trunc(parsed));
      }

      function formatUsd(value) {
        const parsed = Number(value || 0);
        if (!Number.isFinite(parsed)) {
          return '$0.0000';
        }
        return '$' + parsed.toFixed(4);
      }

      function renderUsageByModelRows(usageSummary) {
        const tbody = document.getElementById('usageByModelBody');
        if (!tbody) {
          return;
        }
        tbody.innerHTML = '';

        const rows = Array.isArray(usageSummary?.byModel) ? usageSummary.byModel : [];
        if (rows.length === 0) {
          const row = document.createElement('tr');
          row.innerHTML = '<td colspan="7" class="muted">No LLM usage in this window.</td>';
          tbody.appendChild(row);
          return;
        }

        for (const item of rows) {
          const row = document.createElement('tr');
          row.innerHTML =
            '<td><code>' + escapeHtml(item.provider || 'unknown') + '</code></td>' +
            '<td>' + escapeHtml(item.model || 'unknown') + '</td>' +
            '<td>' + formatCount(item.requestCount) + '</td>' +
            '<td>' + formatCount(item.inputTokens) + '</td>' +
            '<td>' + formatCount(item.outputTokens) + '</td>' +
            '<td>' + formatCount(item.totalTokens) + '</td>' +
            '<td>' + formatUsd(item.estimatedCostUsd) + '</td>';
          tbody.appendChild(row);
        }
      }

      function renderUsageSummary(usageSummary) {
        latestUsageSummary = usageSummary || null;
        const totals = usageSummary?.totals || {};
        setOverviewMetric('overviewLlmRequests', normalizeCount(totals.llmRequestCount));
        setOverviewMetric('overviewLlmTokens', normalizeCount(totals.llmTotalTokens));
        setOverviewMetric('overviewEmailSends', normalizeCount(totals.emailSendCount));
        setOverviewMetric('overviewCalendarApiCalls', normalizeCount(totals.calendarApiCallCount));
        setOverviewMetric('overviewInvocations', normalizeCount(totals.invocationCount));
        setOverviewText('overviewEstimatedCost', formatUsd(totals.estimatedTotalCostUsd));
        renderUsageByModelRows(usageSummary);
      }

      function renderOverviewMetrics() {
        const connectedCalendars = latestConnections.filter((connection) => String(connection?.status || '').toLowerCase() === 'connected').length;
        const totalClients = latestClients.length;
        const blockedClients = latestClients.filter((client) => String(client?.accessState || '').toLowerCase() === 'blocked').length;
        const activeClients = latestClients.filter((client) => String(client?.accessState || '').toLowerCase() === 'active').length;
        const emailUses = latestClients.reduce((sum, client) => sum + normalizeCount(client?.emailAgentCount), 0);
        const webUses = latestClients.reduce((sum, client) => sum + normalizeCount(client?.availabilityWebCount), 0);
        const totalInteractions = latestClients.reduce((sum, client) => sum + normalizeCount(client?.totalInteractionCount), 0);

        setOverviewMetric('overviewConnectedCalendars', connectedCalendars);
        setOverviewMetric('overviewTotalClients', totalClients);
        setOverviewMetric('overviewActiveClients', activeClients);
        setOverviewMetric('overviewBlockedClients', blockedClients);
        setOverviewMetric('overviewEmailUses', emailUses);
        setOverviewMetric('overviewWebUses', webUses);
        setOverviewMetric('overviewTotalInteractions', totalInteractions);

        const usageHint = document.getElementById('overviewUsageHint');
        if (usageHint) {
          const usageWindow = String(latestUsageSummary?.window || selectedUsageWindow || 'weekly');
          const rangeStart = String(latestUsageSummary?.range?.startIso || '').slice(0, 19).replace('T', ' ');
          const rangeEnd = String(latestUsageSummary?.range?.endIso || '').slice(0, 19).replace('T', ' ');
          if (rangeStart && rangeEnd) {
            usageHint.textContent =
              'Usage window: ' + usageWindow + ' (' + rangeStart + ' UTC to ' + rangeEnd + ' UTC). Cost is an estimate from configurable token and infrastructure rates.';
          } else {
            usageHint.textContent = 'Usage and billing metrics are loading.';
          }
        }
        renderWorkspaceHints();
        updateWorkspaceSummaries();
      }

      async function loadUsageSummary(windowKey = selectedUsageWindow) {
        const normalizedWindow = String(windowKey || 'weekly').trim().toLowerCase();
        const usageWindowSelect = document.getElementById('usageWindowSelect');
        if (usageWindowSelect) {
          usageWindowSelect.value = normalizedWindow;
        }
        selectedUsageWindow = normalizedWindow;

        const response = await fetch('./advisor/api/usage-summary?window=' + encodeURIComponent(normalizedWindow));
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Unable to load usage summary.');
        }
        renderUsageSummary(payload);
        renderOverviewMetrics();
      }

      async function loadConnections() {
        const response = await fetch('./advisor/api/connections');
        const payload = await response.json();
        const tbody = document.getElementById('connectionsBody');
        tbody.innerHTML = '';
        latestConnections = Array.isArray(payload.connections) ? payload.connections : [];
        renderOverviewMetrics();

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

      function normalizeClientEmailInput(value) {
        const normalized = String(value || '').trim().toLowerCase();
        const match = normalized.match(/[a-z0-9._%+-]+@[a-z0-9.-]+/);
        return match ? match[0] : '';
      }

      function normalizeClientSearchInput(value) {
        return String(value || '').trim().toLowerCase();
      }

      function clientMatchesSearch(client, query) {
        if (!query) {
          return true;
        }
        const displayName = String(client?.clientDisplayName || '').toLowerCase();
        const email = String(client?.clientEmail || client?.clientId || '').toLowerCase();
        return displayName.includes(query) || email.includes(query);
      }

      function updateClientListSummary(filteredCount, totalCount) {
        const node = document.getElementById('clientListSummary');
        if (!node) {
          return;
        }

        if (totalCount <= 0) {
          node.textContent = 'No clients yet.';
          return;
        }

        if (filteredCount === totalCount) {
          node.textContent = 'Showing all ' + totalCount + ' clients.';
          return;
        }

        node.textContent = 'Showing ' + filteredCount + ' of ' + totalCount + ' clients.';
      }

      function renderClientPolicyOptions() {
        const selector = document.getElementById('newClientPolicy');
        if (!selector) {
          return;
        }

        const options = Array.isArray(policyOptions) && policyOptions.length > 0
          ? policyOptions
          : ['default'];
        selector.innerHTML = options
          .map((policyId) => '<option value="' + escapeHtml(policyId) + '">' + escapeHtml(policyId) + '</option>')
          .join('');
      }

      function setClientImportStatus(text, cssClass) {
        const node = document.getElementById('clientImportStatus');
        if (!node) {
          return;
        }
        node.className = cssClass || 'muted';
        node.textContent = text;
      }

      async function addSingleClient() {
        const emailInput = document.getElementById('newClientEmail');
        const displayNameInput = document.getElementById('newClientDisplayName');
        const policyInput = document.getElementById('newClientPolicy');
        const clientEmail = normalizeClientEmailInput(emailInput.value);
        if (!clientEmail) {
          throw new Error('Enter a valid client email.');
        }

        const payload = {
          clientEmail,
          clientDisplayName: String(displayNameInput.value || '').trim(),
          policyId: String(policyInput?.value || 'default').trim() || 'default'
        };
        const response = await fetch('./advisor/api/clients', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || 'Client add failed');
        }

        emailInput.value = '';
        displayNameInput.value = '';
        setClientImportStatus('Client added to allowlist: ' + clientEmail, 'ok');
        await loadClients();
      }

      async function bulkImportClientEmails() {
        const textarea = document.getElementById('bulkClientEmails');
        const policyInput = document.getElementById('newClientPolicy');
        const clientEmails = String(textarea.value || '')
          .split(/\\r?\\n/)
          .map((line) => normalizeClientEmailInput(line))
          .filter(Boolean);
        if (clientEmails.length === 0) {
          throw new Error('Enter at least one client email for bulk import.');
        }

        const response = await fetch('./advisor/api/clients/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientEmails,
            policyId: String(policyInput?.value || 'default').trim() || 'default'
          })
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Bulk import failed');
        }

        textarea.value = '';
        const importedCount = Number(payload.importedCount || 0);
        setClientImportStatus('Bulk import complete. Imported/updated clients: ' + importedCount, 'ok');
        await loadClients();
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
          latestPolicies = [];
          policyOptions = ['default', 'weekend', 'monday'];
          renderClientPolicyOptions();
          updateWorkspaceSummaries();
          return;
        }

        const policies = Array.isArray(payload.policies) ? payload.policies : [];
        latestPolicies = policies;
        policyOptions = Array.isArray(payload.policyOptions) && payload.policyOptions.length > 0
          ? payload.policyOptions
          : ['default', 'weekend', 'monday'];
        renderClientPolicyOptions();
        updateWorkspaceSummaries();

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

      function renderClientsTableRows() {
        const tbody = document.getElementById('clientsBody');
        tbody.innerHTML = '';
        const clients = Array.isArray(latestClients) ? latestClients : [];
        const availablePolicies = Array.isArray(latestClientPolicyOptions) && latestClientPolicyOptions.length > 0
          ? latestClientPolicyOptions
          : ['default', 'weekend', 'monday'];
        const normalizedSearchQuery = normalizeClientSearchInput(clientSearchQuery);
        const filteredClients = clients.filter((client) => clientMatchesSearch(client, normalizedSearchQuery));
        updateClientListSummary(filteredClients.length, clients.length);

        if (clients.length === 0) {
          const row = document.createElement('tr');
          row.innerHTML = '<td colspan="9" class="muted">No clients yet.</td>';
          tbody.appendChild(row);
          return;
        }

        if (filteredClients.length === 0) {
          const row = document.createElement('tr');
          row.innerHTML = '<td colspan="9" class="muted">No clients match the current search.</td>';
          tbody.appendChild(row);
          return;
        }

        for (const client of filteredClients) {
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

      async function loadClients() {
        const tbody = document.getElementById('clientsBody');
        tbody.innerHTML = '';
        const response = await fetch('./advisor/api/clients');
        const payload = await response.json();
        if (!response.ok) {
          latestClients = [];
          latestClientPolicyOptions = Array.isArray(policyOptions) && policyOptions.length > 0
            ? policyOptions
            : ['default', 'weekend', 'monday'];
          renderOverviewMetrics();
          updateClientListSummary(0, 0);
          const row = document.createElement('tr');
          row.innerHTML = '<td colspan="9" class="error">' + escapeHtml(payload.error || 'Unable to load clients.') + '</td>';
          tbody.appendChild(row);
          return;
        }

        latestClients = Array.isArray(payload.clients) ? payload.clients : [];
        latestClientPolicyOptions =
          Array.isArray(policyOptions) && policyOptions.length > 0
            ? policyOptions
            : Array.isArray(payload.policyOptions) && payload.policyOptions.length > 0
              ? payload.policyOptions
              : ['default', 'weekend', 'monday'];
        renderOverviewMetrics();
        renderClientsTableRows();
      }

      async function refreshPortalDataNow() {
        await Promise.all([
          loadConnections(),
          loadPolicies(),
          loadClients(),
          loadAdvisorSettings(),
          loadUsageSummary(selectedUsageWindow)
        ]);
      }

      document.getElementById('refreshPortalData').addEventListener('click', async () => {
        await refreshPortalDataNow();
      });

      const refreshPortalDataTopButton = document.getElementById('refreshPortalDataTop');
      if (refreshPortalDataTopButton) {
        refreshPortalDataTopButton.addEventListener('click', async () => {
          await refreshPortalDataNow();
        });
      }

      document.getElementById('refreshUsageSummary').addEventListener('click', async () => {
        try {
          await loadUsageSummary(selectedUsageWindow);
        } catch (error) {
          console.error(error);
        }
      });

      document.getElementById('usageWindowSelect').addEventListener('change', async (event) => {
        selectedUsageWindow = String(event.target?.value || 'weekly').trim().toLowerCase();
        try {
          await loadUsageSummary(selectedUsageWindow);
        } catch (error) {
          console.error(error);
        }
      });

      document.getElementById('saveAdvisorSettings').addEventListener('click', async () => {
        try {
          await saveAdvisorSettings();
        } catch (error) {
          setAdvisorSettingsStatus(error.message || 'Advisor profile save failed.', 'error');
        }
      });

      document.getElementById('saveBrandLogo').addEventListener('click', async () => {
        try {
          await saveUploadedBrandLogo();
        } catch (error) {
          setBrandStatus(error.message || 'Logo upload failed.', 'error');
        }
      });

      document.getElementById('resetBrandLogo').addEventListener('click', () => {
        const input = document.getElementById('brandLogoFile');
        if (input) {
          input.value = '';
        }

        if (!removeStoredBrandLogo()) {
          setBrandStatus('Unable to clear custom logo from this browser.', 'error');
          return;
        }

        applyPortalBranding();
      });

      document.getElementById('createPolicy').addEventListener('click', async () => {
        try {
          await createPolicyPreset();
        } catch (error) {
          window.alert(error.message || 'Policy create failed');
        }
      });

      document.getElementById('addClient').addEventListener('click', async () => {
        try {
          await addSingleClient();
        } catch (error) {
          setClientImportStatus(error.message || 'Client add failed.', 'error');
        }
      });

      document.getElementById('bulkImportClients').addEventListener('click', async () => {
        try {
          await bulkImportClientEmails();
        } catch (error) {
          setClientImportStatus(error.message || 'Bulk import failed.', 'error');
        }
      });

      document.getElementById('clientSearchInput').addEventListener('input', (event) => {
        clientSearchQuery = normalizeClientSearchInput(event.target?.value || '');
        renderClientsTableRows();
      });

      document.getElementById('clearClientSearch').addEventListener('click', () => {
        const input = document.getElementById('clientSearchInput');
        if (input) {
          input.value = '';
          input.focus();
        }
        clientSearchQuery = '';
        renderClientsTableRows();
      });

      const workspaceClientQuickSearchInput = document.getElementById('workspaceClientQuickSearch');
      if (workspaceClientQuickSearchInput) {
        workspaceClientQuickSearchInput.addEventListener('input', (event) => {
          workspaceClientQuickQuery = normalizeClientSearchInput(event.target?.value || '');
          renderWorkspaceClientQuickList();
        });
      }

      const workspaceClientQuickSearchClearButton = document.getElementById('workspaceClientQuickSearchClear');
      if (workspaceClientQuickSearchClearButton) {
        workspaceClientQuickSearchClearButton.addEventListener('click', () => {
          const input = document.getElementById('workspaceClientQuickSearch');
          if (input) {
            input.value = '';
            input.focus();
          }
          workspaceClientQuickQuery = '';
          renderWorkspaceClientQuickList();
        });
      }

      document.getElementById('googleConnect').addEventListener('click', () => {
        window.location.href = './advisor/api/connections/google/start';
      });

      document.getElementById('microsoftConnect').addEventListener('click', () => {
        window.location.href = './advisor/api/connections/microsoft/start';
      });

      function openAdvisorCalendarView() {
        const targetUrl = './advisor/calendar?weekOffset=0';
        const openedWindow = window.open(targetUrl, '_blank');
        if (openedWindow) {
          try {
            openedWindow.opener = null;
          } catch (_error) {
            // Ignore cross-window hardening errors.
          }
          if (typeof openedWindow.focus === 'function') {
            openedWindow.focus();
          }
        }
      }

      const openAdvisorCalendarViewButton = document.getElementById('openAdvisorCalendarView');
      if (openAdvisorCalendarViewButton) {
        openAdvisorCalendarViewButton.addEventListener('click', openAdvisorCalendarView);
      }

      const openAdvisorCalendarViewTopButton = document.getElementById('openAdvisorCalendarViewTop');
      if (openAdvisorCalendarViewTopButton) {
        openAdvisorCalendarViewTopButton.addEventListener('click', openAdvisorCalendarView);
      }

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
          updateWorkspaceSummaries();
          return;
        }

        lastTrace = payload.trace;
        renderTrace(payload);
        setTraceStatus('Trace loaded. You can submit feedback below.', 'ok');
        updateWorkspaceSummaries();
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
          updateWorkspaceSummaries();
          return;
        }

        setTraceStatus('Feedback recorded.', 'ok');
        updateWorkspaceSummaries();
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

      bindWorkspacePanelInteractions();
      applyPortalBranding();
      showStatusFromQuery();
      renderOverviewMetrics();
      updateAdvisorHeader();
      loadAdvisorSettings().catch((error) => {
        setAdvisorSettingsStatus(error.message || 'Unable to load advisor profile settings.', 'error');
      });
      loadConnections().catch((error) => {
        console.error(error);
      });
      loadPolicies().catch((error) => {
        console.error(error);
      });
      loadClients().catch((error) => {
        console.error(error);
      });
      loadUsageSummary(selectedUsageWindow).catch((error) => {
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

async function exchangeCodeForTokens({
  tokenEndpoint,
  providerLabel,
  clientId,
  clientSecret,
  code,
  redirectUri,
  scope,
  fetchImpl
}) {
  const fetchFn = fetchImpl ?? fetch;
  const form = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });
  if (scope) {
    form.set("scope", scope);
  }

  const response = await fetchFn(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${providerLabel} code exchange failed (${response.status}): ${message}`);
  }

  return response.json();
}

function buildMicrosoftTokenEndpoint(tenantId) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

async function exchangeGoogleCodeForTokens({ clientId, clientSecret, code, redirectUri, fetchImpl }) {
  return exchangeCodeForTokens({
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    providerLabel: "Google",
    clientId,
    clientSecret,
    code,
    redirectUri,
    fetchImpl
  });
}

async function exchangeMicrosoftCodeForTokens({
  clientId,
  clientSecret,
  tenantId,
  code,
  redirectUri,
  fetchImpl
}) {
  return exchangeCodeForTokens({
    tokenEndpoint: buildMicrosoftTokenEndpoint(tenantId),
    providerLabel: "Microsoft",
    clientId,
    clientSecret,
    code,
    redirectUri,
    scope: "openid profile email offline_access User.Read Calendars.Read",
    fetchImpl
  });
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

async function fetchMicrosoftUserProfile(accessToken, fetchImpl) {
  const fetchFn = fetchImpl ?? fetch;
  const response = await fetchFn("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName", {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    return { email: null };
  }

  const payload = await response.json();
  const email = String(payload.mail ?? payload.userPrincipalName ?? "").trim();
  return {
    email: email || null,
    displayName: String(payload.displayName ?? "").trim() || null
  };
}

export function createPortalHandler(overrides = {}) {
  const runtimeDeps = createRuntimeDeps();
  const deps = {
    ...runtimeDeps,
    lookupBusyIntervals: ({ provider = "google", ...args }) => {
      if (provider === "microsoft") {
        return lookupMicrosoftBusyIntervals(args);
      }
      return lookupGoogleBusyIntervals(args);
    },
    lookupClientMeetings: ({ provider = "google", ...args }) => {
      if (provider === "microsoft") {
        return lookupMicrosoftClientMeetings(args);
      }
      return lookupGoogleClientMeetings(args);
    },
    lookupAdvisorMeetings: ({ provider = "google", ...args }) => {
      if (provider === "microsoft") {
        return lookupMicrosoftAdvisorMeetings(args);
      }
      return lookupGoogleAdvisorMeetings(args);
    },
    ...overrides
  };

  return async function handler(event) {
    const method = event.requestContext?.http?.method ?? "GET";
    const rawPath = normalizeRawPath(event.rawPath ?? "/", event.requestContext?.stage);

    const authMode = resolveAdvisorPortalAuthMode();
    const strictMultiTenantMode = parseBooleanEnv(
      process.env.STRICT_MULTI_TENANT_MODE,
      authMode === "google_oauth"
    );
    const configuredAdvisorId = strictMultiTenantMode
      ? "advisor"
      : normalizeAdvisorId(process.env.ADVISOR_ID, "advisor");
    const appName = process.env.APP_NAME ?? "calendar-agent-spike";
    const stage = process.env.STAGE ?? "dev";
    const connectionsTableName = process.env.CONNECTIONS_TABLE_NAME;
    const clientProfilesTableName = process.env.CLIENT_PROFILES_TABLE_NAME;
    const traceTableName = process.env.TRACE_TABLE_NAME;
    const oauthStateTableName = process.env.OAUTH_STATE_TABLE_NAME;
    const googleAppSecretArn = process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
    const microsoftAppSecretArn = process.env.MICROSOFT_OAUTH_APP_SECRET_ARN;
    const sessionSecretArn = process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN;
    const availabilityLinkSecretArn = process.env.AVAILABILITY_LINK_SECRET_ARN;
    const availabilityLinkTableName = process.env.AVAILABILITY_LINK_TABLE_NAME;
    const googleOauthSecretArn = process.env.GOOGLE_OAUTH_SECRET_ARN;
    const microsoftOauthSecretArn = process.env.MICROSOFT_OAUTH_SECRET_ARN;
    const policyPresetsTableName = process.env.POLICY_PRESETS_TABLE_NAME;
    const advisorSettingsTableName = process.env.ADVISOR_SETTINGS_TABLE_NAME;
    const defaultAgentEmailDomain = normalizeAgentEmailDomain(process.env.DEFAULT_AGENT_EMAIL_DOMAIN);
    const calendarMode = (process.env.CALENDAR_MODE ?? "connection").toLowerCase();
    const hostTimezone = normalizeTimezone(process.env.HOST_TIMEZONE, DEFAULT_ADVISOR_TIMEZONE);
    const advisingDays = parseAdvisingDays(process.env.ADVISING_DAYS ?? "Tue,Wed");
    const basePolicyPresets = parseClientPolicyPresets(process.env.CLIENT_POLICY_PRESETS_JSON, advisingDays);
    const workdayStartHour = parseClampedIntEnv(process.env.WORKDAY_START_HOUR, 9, 0, 23);
    const workdayEndHour = parseClampedIntEnv(process.env.WORKDAY_END_HOUR, 17, 1, 24);
    const normalizedWorkdayEndHour = Math.min(24, Math.max(workdayEndHour, workdayStartHour + 1));
    const defaultDurationMinutes = parseClampedIntEnv(process.env.DEFAULT_DURATION_MINUTES, 30, 15, 180);
    const maxDurationMinutes = parseClampedIntEnv(process.env.MAX_DURATION_MINUTES, 120, 15, 240);
    const availabilitySlotMinutes = parseClampedIntEnv(process.env.AVAILABILITY_VIEW_SLOT_MINUTES, 30, 15, 60);
    const availabilityCompareUiEnabled = parseBooleanEnv(process.env.AVAILABILITY_COMPARE_UI_ENABLED, false);
    const availabilityViewMaxSlots = parseClampedIntEnv(process.env.AVAILABILITY_VIEW_MAX_SLOTS, 240, 24, 1200);
    const llmInputCostPer1KUsd = Math.max(0, parseFloatEnv(process.env.LLM_INPUT_COST_PER_1K_USD, 0.003));
    const llmOutputCostPer1KUsd = Math.max(0, parseFloatEnv(process.env.LLM_OUTPUT_COST_PER_1K_USD, 0.009));
    const emailSendCostUsd = Math.max(0, parseFloatEnv(process.env.EMAIL_SEND_COST_USD, 0.0001));
    const calendarApiCallCostUsd = Math.max(0, parseFloatEnv(process.env.CALENDAR_API_CALL_COST_USD, 0.000002));
    const lambdaInvocationCostUsd = Math.max(0, parseFloatEnv(process.env.LAMBDA_INVOCATION_COST_USD, 0.0000002));

    const authFailure = await authorizePortalRequest({ event, rawPath, deps });
    if (authFailure) {
      return authFailure;
    }

    const sessionPayload = await readPortalSessionPayload(event, deps);
    const sessionAdvisorEmail = normalizeAdvisorEmail(sessionPayload?.email);
    const advisorIdFallback = strictMultiTenantMode ? "advisor" : configuredAdvisorId;
    const advisorId = sessionPayload?.advisorId
      ? normalizeAdvisorId(sessionPayload.advisorId, advisorIdFallback)
      : deriveAdvisorIdFromEmail(sessionAdvisorEmail, advisorIdFallback);
    const advisorEmail = sessionAdvisorEmail;

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

    if (method === "GET" && (rawPath === "/" || rawPath === "/landing")) {
      const baseUrl = getBaseUrl(event);
      const googleLoginUrl = `${baseUrl}/advisor/auth/google/start?returnTo=${encodeURIComponent("/advisor")}`;
      return htmlResponse(
        200,
        buildAdvisorLandingPage({
          googleLoginUrl
        })
      );
    }

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
      let effectiveAvailabilityAdvisorId = advisorId;
      let availabilityHostTimezone = hostTimezone;

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

        effectiveAvailabilityAdvisorId = normalizeAdvisorId(linkRecord.advisorId, advisorId);

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

        effectiveAvailabilityAdvisorId = normalizeAdvisorId(tokenPayload.advisorId, advisorId);

        requestedDuration = Number(tokenPayload.durationMinutes);
        linkExpiresAtMs = Number(tokenPayload.expiresAtMs);
      }

      if (advisorSettingsTableName && typeof deps.getAdvisorSettings === "function") {
        const availabilityAdvisorSettings = await deps.getAdvisorSettings(
          advisorSettingsTableName,
          effectiveAvailabilityAdvisorId
        );
        availabilityHostTimezone = normalizeTimezone(availabilityAdvisorSettings?.timezone, hostTimezone);
      }

      let availabilityPolicyPresets = basePolicyPresets;
      if (policyPresetsTableName && typeof deps.listPolicyPresets === "function") {
        try {
          const availabilityCustomPolicies = await deps.listPolicyPresets(
            policyPresetsTableName,
            effectiveAvailabilityAdvisorId
          );
          availabilityPolicyPresets = mergeClientPolicyPresets(basePolicyPresets, availabilityCustomPolicies);
        } catch {
          availabilityPolicyPresets = basePolicyPresets;
        }
      }

      let effectiveAdvisingDays = advisingDays;
      if (clientProfilesTableName && linkClientId && typeof deps.getClientProfile === "function") {
        const clientProfile = await deps.getClientProfile(
          clientProfilesTableName,
          effectiveAvailabilityAdvisorId,
          linkClientId
        );
        if (isClientAccessRestricted(clientProfile)) {
          return availabilityErrorPage("This client no longer has access to advisor availability.");
        }

        effectiveAdvisingDays = resolveClientAdvisingDays({
          clientProfile,
          defaultAdvisingDays: advisingDays,
          policyPresets: availabilityPolicyPresets
        });
      }

      const durationMinutes = Number.isFinite(requestedDuration)
        ? Math.min(Math.max(requestedDuration, 15), maxDurationMinutes)
        : defaultDurationMinutes;
      const nowMs = Date.now();
      const baseWeekStartLocal = DateTime.fromMillis(nowMs, { zone: availabilityHostTimezone }).startOf("week");
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
          advisorId: effectiveAvailabilityAdvisorId,
          googleOauthSecretArn,
          microsoftOauthSecretArn,
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
        hostTimezone: availabilityHostTimezone,
        advisingDays: effectiveAdvisingDays,
        searchStartIso,
        searchEndIso,
        workdayStartHour,
        workdayEndHour: normalizedWorkdayEndHour,
        slotMinutes: availabilitySlotMinutes,
        requestedDurationMinutes: durationMinutes,
        maxCells: availabilityViewMaxSlots
      });

      if (
        clientProfilesTableName &&
        linkClientId &&
        typeof deps.recordClientAvailabilityViewInteraction === "function"
      ) {
        try {
          await deps.recordClientAvailabilityViewInteraction(clientProfilesTableName, {
            advisorId: effectiveAvailabilityAdvisorId,
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

      let browserGoogleClientId = "";
      if (googleAppSecretArn && typeof deps.getSecretString === "function") {
        try {
          const appSecret = parseGoogleAppSecret(await deps.getSecretString(googleAppSecretArn));
          browserGoogleClientId = String(appSecret.clientId ?? "").trim();
        } catch {
          browserGoogleClientId = "";
        }
      }

      return htmlResponse(
        200,
        buildAvailabilityPage({
          calendarModel,
          hostTimezone: availabilityHostTimezone,
          windowStartIso: searchStartIso,
          windowEndIso: searchEndIso,
          expiresAtMs: linkExpiresAtMs,
          tokenParamName,
          token: effectiveToken,
          weekOffset,
          windowLabel,
          clientDisplayName: linkClientDisplayName,
          clientReference: linkClientReference,
          browserGoogleClientId,
          compareUiEnabled: availabilityCompareUiEnabled
        })
      );
    }

    if (method === "GET" && rawPath === "/advisor/calendar") {
      let advisorCalendarTimezone = hostTimezone;
      let advisorDisplayName = deriveAdvisorPreferredNameFromEmail(advisorEmail, advisorId);

      if (advisorSettingsTableName && typeof deps.getAdvisorSettings === "function") {
        try {
          const advisorSettings = await deps.getAdvisorSettings(advisorSettingsTableName, advisorId);
          advisorCalendarTimezone = normalizeTimezone(advisorSettings?.timezone, hostTimezone);
          const preferredName = normalizeAdvisorPreferredName(advisorSettings?.preferredName);
          if (preferredName) {
            advisorDisplayName = preferredName;
          }
        } catch {
          advisorCalendarTimezone = hostTimezone;
        }
      }

      if (calendarMode === "connection" && connectionsTableName && typeof deps.listConnections === "function") {
        const connections = await deps.listConnections(connectionsTableName, advisorId);
        const connectedConnections = (Array.isArray(connections) ? connections : []).filter(
          (connection) => String(connection?.status ?? "").toLowerCase() === "connected"
        );
        if (connectedConnections.length === 0) {
          return htmlResponse(200, buildAdvisorCalendarUnavailablePage({ advisorDisplayName }));
        }
      }

      const weekOffset = parseWeekOffset(event.queryStringParameters);
      const nowMs = Date.now();
      const baseWeekStartLocal = DateTime.fromMillis(nowMs, { zone: advisorCalendarTimezone }).startOf("week");
      const searchStartLocal = baseWeekStartLocal.plus({ weeks: weekOffset });
      const searchEndLocal = searchStartLocal.plus({ days: AVAILABILITY_VIEW_DAYS });
      const searchStartIso = searchStartLocal.toUTC().toISO();
      const searchEndIso = searchEndLocal.toUTC().toISO();
      const windowEndLabelLocal = searchEndLocal.minus({ days: 1 });
      const windowLabel = `${searchStartLocal.toFormat("MMM dd, yyyy")} - ${windowEndLabelLocal.toFormat(
        "MMM dd, yyyy"
      )}`;

      let availabilityContext;
      try {
        availabilityContext = await lookupAvailabilityContext({
          deps,
          calendarMode,
          connectionsTableName,
          advisorId,
          googleOauthSecretArn,
          microsoftOauthSecretArn,
          searchStartIso,
          searchEndIso,
          clientEmail: "",
          includeAllMeetings: true
        });
      } catch (error) {
        return serverError(`advisor calendar lookup failed: ${error.message}`);
      }

      const calendarModel = buildAvailabilityCalendarModel({
        busyIntervalsUtc: availabilityContext.busyIntervals,
        clientMeetingsUtc: availabilityContext.clientMeetings,
        nonClientBusyIntervalsUtc: availabilityContext.nonClientBusyIntervals,
        hostTimezone: advisorCalendarTimezone,
        advisingDays,
        searchStartIso,
        searchEndIso,
        workdayStartHour,
        workdayEndHour: normalizedWorkdayEndHour,
        slotMinutes: availabilitySlotMinutes,
        requestedDurationMinutes: availabilitySlotMinutes,
        maxCells: availabilityViewMaxSlots
      });

      return htmlResponse(
        200,
        buildAvailabilityPage({
          calendarModel,
          hostTimezone: advisorCalendarTimezone,
          windowStartIso: searchStartIso,
          windowEndIso: searchEndIso,
          expiresAtMs: Date.now() + 7 * 24 * 60 * 60 * 1000,
          tokenParamName: "",
          token: "",
          weekOffset,
          windowLabel,
          clientDisplayName: advisorDisplayName,
          clientReference: "",
          browserGoogleClientId: "",
          compareUiEnabled: false
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
      if (!stateItem || stateItem.purpose !== "portal_login") {
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
      const tokenPayload = await exchangeGoogleCodeForTokens({
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
      const loginEmail = normalizeAdvisorEmail(profile.email);
      const loginAdvisorId = deriveAdvisorIdFromEmail(loginEmail, "advisor");
      const derivedPreferredName = deriveAdvisorPreferredNameFromGoogleProfile(profile, loginAdvisorId);
      const defaultAgentEmail = deriveDefaultAgentEmail({
        advisorId: loginAdvisorId,
        advisorEmail: loginEmail,
        domain: defaultAgentEmailDomain
      });

      if (advisorSettingsTableName && typeof deps.getAdvisorSettings === "function" && typeof deps.putAdvisorSettings === "function") {
        try {
          const existingSettings = await deps.getAdvisorSettings(advisorSettingsTableName, loginAdvisorId);
          const seededAgentEmail =
            existingSettings?.agentEmail ||
            (await ensureUniqueAgentEmail({
              deps,
              advisorSettingsTableName,
              advisorId: loginAdvisorId,
              requestedAgentEmail: defaultAgentEmail
            }));
          const nextSettings = normalizeAdvisorSettingsRecord({
            advisorId: loginAdvisorId,
            settings: {
              ...existingSettings,
              advisorEmail: existingSettings?.advisorEmail || loginEmail,
              agentEmail: seededAgentEmail || defaultAgentEmail,
              inviteEmail: existingSettings?.inviteEmail || loginEmail,
              preferredName: existingSettings?.preferredName || derivedPreferredName,
              timezone: existingSettings?.timezone || DEFAULT_ADVISOR_TIMEZONE
            },
            fallbackAdvisorEmail: loginEmail,
            fallbackInviteEmail: loginEmail,
            fallbackPreferredName: derivedPreferredName,
            fallbackTimezone: DEFAULT_ADVISOR_TIMEZONE,
            fallbackAgentEmailDomain: defaultAgentEmailDomain
          });

          const hasChanged =
            !existingSettings ||
            String(existingSettings.advisorEmail ?? "") !== nextSettings.advisorEmail ||
            String(existingSettings.agentEmail ?? "") !== nextSettings.agentEmail ||
            String(existingSettings.inviteEmail ?? "") !== nextSettings.inviteEmail ||
            String(existingSettings.preferredName ?? "") !== nextSettings.preferredName ||
            String(existingSettings.timezone ?? "") !== nextSettings.timezone;
          if (hasChanged) {
            await deps.putAdvisorSettings(advisorSettingsTableName, nextSettings);
          }
        } catch {
          // Best-effort advisor profile hydration after Google login.
        }
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
          email: loginEmail,
          advisorId: loginAdvisorId,
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

    if (method === "GET" && rawPath === "/advisor/api/settings") {
      if (!advisorSettingsTableName) {
        return serverError("ADVISOR_SETTINGS_TABLE_NAME is required");
      }

      const fallbackAdvisorEmail = normalizeAdvisorEmail(
        advisorEmail ?? process.env.ADVISOR_ALLOWED_EMAIL ?? ""
      );
      const fallbackInviteEmail = normalizeAdvisorEmail(
        process.env.ADVISOR_INVITE_EMAIL ?? fallbackAdvisorEmail
      );
      const fallbackPreferredName =
        normalizeAdvisorPreferredName(process.env.ADVISOR_DISPLAY_NAME ?? "") ||
        deriveAdvisorPreferredNameFromEmail(fallbackAdvisorEmail || fallbackInviteEmail, advisorId);
      const fallbackTimezone = normalizeTimezone(process.env.HOST_TIMEZONE, DEFAULT_ADVISOR_TIMEZONE);
      const fallbackLlmProvider = normalizeLlmProvider(process.env.LLM_DEFAULT_PROVIDER, DEFAULT_LLM_PROVIDER);
      const fallbackLlmModel = normalizeLlmModel(process.env.LLM_DEFAULT_MODEL, DEFAULT_LLM_MODEL);
      const fallbackLlmEndpoint = normalizeLlmEndpoint(process.env.LLM_DEFAULT_ENDPOINT, DEFAULT_LLM_ENDPOINT);

      const existingSettings = await deps.getAdvisorSettings(advisorSettingsTableName, advisorId);
      let normalizedSettings = normalizeAdvisorSettingsRecord({
        advisorId,
        settings: existingSettings ?? {},
        fallbackAdvisorEmail,
        fallbackInviteEmail,
        fallbackPreferredName,
        fallbackTimezone,
        fallbackAgentEmailDomain: defaultAgentEmailDomain,
        fallbackLlmProvider,
        fallbackLlmModel,
        fallbackLlmEndpoint
      });

      if (!existingSettings && typeof deps.putAdvisorSettings === "function") {
        const uniqueAgentEmail = await ensureUniqueAgentEmail({
          deps,
          advisorSettingsTableName,
          advisorId,
          requestedAgentEmail: normalizedSettings.agentEmail
        });
        if (uniqueAgentEmail && uniqueAgentEmail !== normalizedSettings.agentEmail) {
          normalizedSettings = {
            ...normalizedSettings,
            agentEmail: uniqueAgentEmail
          };
        }
        await deps.putAdvisorSettings(advisorSettingsTableName, normalizedSettings);
      }

      return jsonResponse(200, {
        advisorId,
        settings: {
          advisorEmail: normalizedSettings.advisorEmail,
          agentEmail: normalizedSettings.agentEmail,
          inviteEmail: normalizedSettings.inviteEmail,
          preferredName: normalizedSettings.preferredName,
          timezone: normalizedSettings.timezone,
          llmKeyMode: normalizedSettings.llmKeyMode,
          llmProvider: normalizedSettings.llmProvider,
          llmModel: normalizedSettings.llmModel,
          llmEndpoint: normalizedSettings.llmEndpoint,
          advisorLlmKeyConfigured: Boolean(normalizedSettings.llmProviderSecretArn),
          createdAt: normalizedSettings.createdAt,
          updatedAt: normalizedSettings.updatedAt
        }
      });
    }

    if (method === "PATCH" && rawPath === "/advisor/api/settings") {
      if (!advisorSettingsTableName) {
        return serverError("ADVISOR_SETTINGS_TABLE_NAME is required");
      }

      let body;
      try {
        body = parseBody(event);
      } catch {
        return badRequest("Request body must be valid JSON");
      }

      const hasAgentEmail = Object.prototype.hasOwnProperty.call(body, "agentEmail");
      const hasInviteEmail = Object.prototype.hasOwnProperty.call(body, "inviteEmail");
      const hasPreferredName = Object.prototype.hasOwnProperty.call(body, "preferredName");
      const hasTimezone = Object.prototype.hasOwnProperty.call(body, "timezone");
      const hasLlmKeyMode = Object.prototype.hasOwnProperty.call(body, "llmKeyMode");
      const hasLlmProvider = Object.prototype.hasOwnProperty.call(body, "llmProvider");
      const hasLlmModel = Object.prototype.hasOwnProperty.call(body, "llmModel");
      const hasLlmEndpoint = Object.prototype.hasOwnProperty.call(body, "llmEndpoint");
      const hasLlmApiKey = Object.prototype.hasOwnProperty.call(body, "llmApiKey");
      const hasClearAdvisorLlmApiKey = Object.prototype.hasOwnProperty.call(body, "clearAdvisorLlmApiKey");
      if (
        !hasAgentEmail &&
        !hasInviteEmail &&
        !hasPreferredName &&
        !hasTimezone &&
        !hasLlmKeyMode &&
        !hasLlmProvider &&
        !hasLlmModel &&
        !hasLlmEndpoint &&
        !hasLlmApiKey &&
        !hasClearAdvisorLlmApiKey
      ) {
        return badRequest(
          "At least one setting field is required: agentEmail, inviteEmail, preferredName, timezone, llmKeyMode, llmProvider, llmModel, llmEndpoint, llmApiKey, clearAdvisorLlmApiKey"
        );
      }

      const fallbackAdvisorEmail = normalizeAdvisorEmail(
        advisorEmail ?? process.env.ADVISOR_ALLOWED_EMAIL ?? ""
      );
      const fallbackInviteEmail = normalizeAdvisorEmail(
        process.env.ADVISOR_INVITE_EMAIL ?? fallbackAdvisorEmail
      );
      const fallbackPreferredName =
        normalizeAdvisorPreferredName(process.env.ADVISOR_DISPLAY_NAME ?? "") ||
        deriveAdvisorPreferredNameFromEmail(fallbackAdvisorEmail || fallbackInviteEmail, advisorId);
      const fallbackTimezone = normalizeTimezone(process.env.HOST_TIMEZONE, DEFAULT_ADVISOR_TIMEZONE);
      const fallbackLlmProvider = normalizeLlmProvider(process.env.LLM_DEFAULT_PROVIDER, DEFAULT_LLM_PROVIDER);
      const fallbackLlmModel = normalizeLlmModel(process.env.LLM_DEFAULT_MODEL, DEFAULT_LLM_MODEL);
      const fallbackLlmEndpoint = normalizeLlmEndpoint(process.env.LLM_DEFAULT_ENDPOINT, DEFAULT_LLM_ENDPOINT);

      const existingSettings = await deps.getAdvisorSettings(advisorSettingsTableName, advisorId);
      const mergedSettings = {
        ...(existingSettings ?? {})
      };

      if (hasAgentEmail) {
        const normalizedAgentEmail = normalizeAdvisorEmail(body.agentEmail);
        if (!normalizedAgentEmail || !normalizedAgentEmail.includes("@")) {
          return badRequest("agentEmail must be a valid email address");
        }

        const agentDomain = normalizedAgentEmail.split("@")[1];
        if (agentDomain !== defaultAgentEmailDomain) {
          return badRequest(`agentEmail domain must be ${defaultAgentEmailDomain}`);
        }

        if (typeof deps.getAdvisorSettingsByAgentEmail === "function") {
          const existingByAgentEmail = await deps.getAdvisorSettingsByAgentEmail(
            advisorSettingsTableName,
            normalizedAgentEmail
          );
          if (existingByAgentEmail && normalizeAdvisorId(existingByAgentEmail.advisorId) !== normalizeAdvisorId(advisorId)) {
            return badRequest("agentEmail is already in use by another advisor");
          }
        }

        mergedSettings.agentEmail = normalizedAgentEmail;
      }

      if (hasInviteEmail) {
        const inviteEmail = normalizeAdvisorEmail(body.inviteEmail);
        if (!inviteEmail || !inviteEmail.includes("@")) {
          return badRequest("inviteEmail must be a valid email address");
        }
        mergedSettings.inviteEmail = inviteEmail;
      }

      if (hasPreferredName) {
        const preferredName = normalizeAdvisorPreferredName(body.preferredName);
        if (!preferredName) {
          return badRequest("preferredName must not be empty");
        }
        mergedSettings.preferredName = preferredName;
      }

      if (hasTimezone) {
        const requestedTimezone = String(body.timezone ?? "").trim();
        const timezone = normalizeTimezone(requestedTimezone, "");
        if (!requestedTimezone || !timezone) {
          return badRequest("timezone must be a valid IANA timezone (for example America/Los_Angeles)");
        }
        mergedSettings.timezone = timezone;
      }

      if (hasLlmProvider) {
        const llmProvider = normalizeLlmProvider(body.llmProvider, "");
        if (!llmProvider) {
          return badRequest("llmProvider must be one of: openai");
        }
        mergedSettings.llmProvider = llmProvider;
      }

      if (hasLlmModel) {
        const llmModel = normalizeLlmModel(body.llmModel, "");
        if (!llmModel) {
          return badRequest("llmModel must not be empty");
        }
        mergedSettings.llmModel = llmModel;
      }

      if (hasLlmEndpoint) {
        const requestedEndpoint = String(body.llmEndpoint ?? "").trim();
        const llmEndpoint = normalizeLlmEndpoint(requestedEndpoint, "");
        if (!requestedEndpoint || !llmEndpoint) {
          return badRequest("llmEndpoint must be a valid https URL");
        }
        mergedSettings.llmEndpoint = llmEndpoint;
      }

      if (hasLlmKeyMode) {
        const llmKeyMode = normalizeLlmKeyMode(body.llmKeyMode, "");
        if (!llmKeyMode) {
          return badRequest("llmKeyMode must be one of: platform, advisor");
        }
        mergedSettings.llmKeyMode = llmKeyMode;
      }

      if (hasClearAdvisorLlmApiKey) {
        if (body.clearAdvisorLlmApiKey !== true && body.clearAdvisorLlmApiKey !== false) {
          return badRequest("clearAdvisorLlmApiKey must be a boolean");
        }

        if (body.clearAdvisorLlmApiKey === true) {
          const existingSecretArn = normalizeSecretArn(mergedSettings.llmProviderSecretArn);
          if (existingSecretArn && typeof deps.deleteSecret === "function") {
            try {
              await deps.deleteSecret(existingSecretArn);
            } catch {
              // Best-effort secret cleanup.
            }
          }
          mergedSettings.llmProviderSecretArn = "";
          mergedSettings.llmKeyMode = "platform";
        }
      }

      if (hasLlmApiKey) {
        const llmApiKey = String(body.llmApiKey ?? "").trim();
        if (llmApiKey) {
          const nowIso = new Date().toISOString();
          const llmProvider = normalizeLlmProvider(
            mergedSettings.llmProvider,
            fallbackLlmProvider
          );
          const llmModel = normalizeLlmModel(mergedSettings.llmModel, fallbackLlmModel);
          const llmEndpoint = normalizeLlmEndpoint(mergedSettings.llmEndpoint, fallbackLlmEndpoint);
          const secretPayload = JSON.stringify({
            provider: llmProvider,
            api_key: llmApiKey,
            model: llmModel,
            endpoint: llmEndpoint
          });

          const existingSecretArn = normalizeSecretArn(mergedSettings.llmProviderSecretArn);
          let nextSecretArn = existingSecretArn;
          if (existingSecretArn && typeof deps.putSecretValue === "function") {
            await deps.putSecretValue(existingSecretArn, secretPayload);
          } else if (existingSecretArn) {
            return serverError("Secrets update capability is required for advisor LLM keys");
          } else if (typeof deps.createSecret === "function") {
            const secretName = buildAdvisorLlmSecretName({
              appName,
              stage,
              advisorId
            });
            nextSecretArn = await deps.createSecret(secretName, secretPayload);
          } else {
            return serverError("Secrets management capability is required for advisor LLM keys");
          }

          mergedSettings.llmProvider = llmProvider;
          mergedSettings.llmModel = llmModel;
          mergedSettings.llmEndpoint = llmEndpoint;
          mergedSettings.llmProviderSecretArn = nextSecretArn;
          mergedSettings.llmKeyMode = "advisor";
          mergedSettings.llmApiKeyUpdatedAt = nowIso;
        }
      }

      const nextLlmKeyMode = normalizeLlmKeyMode(
        mergedSettings.llmKeyMode,
        normalizeSecretArn(mergedSettings.llmProviderSecretArn) ? "advisor" : "platform"
      );
      if (nextLlmKeyMode === "advisor" && !normalizeSecretArn(mergedSettings.llmProviderSecretArn)) {
        return badRequest("llmApiKey is required before llmKeyMode can be advisor");
      }
      mergedSettings.llmKeyMode = nextLlmKeyMode;

      const normalizedSettings = normalizeAdvisorSettingsRecord({
        advisorId,
        settings: mergedSettings,
        fallbackAdvisorEmail,
        fallbackInviteEmail,
        fallbackPreferredName,
        fallbackTimezone,
        fallbackAgentEmailDomain: defaultAgentEmailDomain,
        fallbackLlmProvider,
        fallbackLlmModel,
        fallbackLlmEndpoint
      });
      await deps.putAdvisorSettings(advisorSettingsTableName, normalizedSettings);

      return jsonResponse(200, {
        advisorId,
        settings: {
          advisorEmail: normalizedSettings.advisorEmail,
          agentEmail: normalizedSettings.agentEmail,
          inviteEmail: normalizedSettings.inviteEmail,
          preferredName: normalizedSettings.preferredName,
          timezone: normalizedSettings.timezone,
          llmKeyMode: normalizedSettings.llmKeyMode,
          llmProvider: normalizedSettings.llmProvider,
          llmModel: normalizedSettings.llmModel,
          llmEndpoint: normalizedSettings.llmEndpoint,
          advisorLlmKeyConfigured: Boolean(normalizedSettings.llmProviderSecretArn),
          createdAt: normalizedSettings.createdAt,
          updatedAt: normalizedSettings.updatedAt
        }
      });
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

    if (method === "GET" && rawPath === "/advisor/api/usage-summary") {
      if (!traceTableName) {
        return serverError("TRACE_TABLE_NAME is required");
      }
      if (typeof deps.listAdvisorTraceSummaries !== "function") {
        return serverError("Trace listing capability is required for usage summary");
      }

      const usageWindow = normalizeUsageWindow(event.queryStringParameters?.window);
      const windowDays = USAGE_WINDOW_DAYS[usageWindow] ?? USAGE_WINDOW_DAYS[DEFAULT_USAGE_WINDOW];
      const endIso = new Date().toISOString();
      const startIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
      const traces = await deps.listAdvisorTraceSummaries(traceTableName, advisorId, {
        startIso,
        endIso
      });

      return jsonResponse(
        200,
        buildAdvisorUsageSummary({
          traces,
          advisorId,
          window: usageWindow,
          startIso,
          endIso,
          llmInputCostPer1KUsd,
          llmOutputCostPer1KUsd,
          emailSendCostUsd,
          calendarApiCallCostUsd,
          lambdaInvocationCostUsd
        })
      );
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

    if (method === "POST" && rawPath === "/advisor/api/clients") {
      if (!clientProfilesTableName) {
        return serverError("CLIENT_PROFILES_TABLE_NAME is required");
      }

      let body;
      try {
        body = parseBody(event);
      } catch {
        return badRequest("Request body must be valid JSON");
      }

      const clientEmail = normalizeAdvisorEmail(body.clientEmail);
      if (!clientEmail || !clientEmail.includes("@")) {
        return badRequest("clientEmail must be a valid email address");
      }

      const clientId = normalizeClientId(clientEmail);
      if (!clientId || clientId.length > 254) {
        return badRequest("Invalid clientId");
      }

      const hasAccessState = Object.prototype.hasOwnProperty.call(body, "accessState");
      const normalizedAccessState = normalizeClientAccessState(
        hasAccessState ? body.accessState : undefined,
        "active"
      );
      if (!["active", "blocked", "deleted"].includes(normalizedAccessState)) {
        return badRequest("accessState must be one of: active, blocked, deleted");
      }

      const hasPolicyId = Object.prototype.hasOwnProperty.call(body, "policyId");
      const normalizedPolicyId = normalizePolicyId(hasPolicyId ? body.policyId : "default");
      if (!normalizedPolicyId || !Object.prototype.hasOwnProperty.call(policyPresets, normalizedPolicyId)) {
        return badRequest(`policyId must be one of: ${policyCatalog.policyOptions.join(", ")}`);
      }

      const nowIso = new Date().toISOString();
      const existing = await deps.getClientProfile(clientProfilesTableName, advisorId, clientId);
      const resolvedAccessState = hasAccessState
        ? normalizedAccessState
        : normalizeClientAccessState(existing?.accessState, "active");
      const resolvedPolicyId = hasPolicyId
        ? normalizedPolicyId
        : normalizePolicyId(existing?.policyId) ?? normalizedPolicyId;
      const next = {
        ...(existing ?? {}),
        advisorId,
        clientId,
        clientEmail,
        clientDisplayName:
          sanitizeClientDisplayName(body.clientDisplayName) ??
          existing?.clientDisplayName ??
          deriveClientDisplayNameFromEmail(clientEmail),
        accessState: resolvedAccessState,
        policyId: resolvedPolicyId,
        admittedSource: existing?.admittedSource ?? "advisor_portal",
        admittedBy: existing?.admittedBy ?? advisorId,
        admittedAt: existing?.admittedAt ?? nowIso,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso
      };
      await deps.putClientProfile(clientProfilesTableName, next);

      return jsonResponse(existing ? 200 : 201, {
        advisorId,
        created: !existing,
        client: normalizeClientProfileForApi(next)
      });
    }

    if (method === "POST" && rawPath === "/advisor/api/clients/import") {
      if (!clientProfilesTableName) {
        return serverError("CLIENT_PROFILES_TABLE_NAME is required");
      }

      let body;
      try {
        body = parseBody(event);
      } catch {
        return badRequest("Request body must be valid JSON");
      }

      const defaultPolicyId = normalizePolicyId(body.policyId ?? "default");
      if (!defaultPolicyId || !Object.prototype.hasOwnProperty.call(policyPresets, defaultPolicyId)) {
        return badRequest(`policyId must be one of: ${policyCatalog.policyOptions.join(", ")}`);
      }

      let rows = [];
      if (Array.isArray(body.clients)) {
        rows = body.clients;
      } else if (Array.isArray(body.clientEmails)) {
        rows = body.clientEmails.map((clientEmail) => ({ clientEmail }));
      } else {
        rows = parseBulkClientEmailList(body.clientEmails ?? body.bulkText ?? body.csv ?? "").map((clientEmail) => ({
          clientEmail
        }));
      }

      if (rows.length === 0) {
        return badRequest("At least one client email is required");
      }

      const dedupedRows = [];
      const seenClientIds = new Set();
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] ?? {};
        const clientEmail = normalizeAdvisorEmail(row.clientEmail ?? row.email ?? row.client_id ?? "");
        if (!clientEmail || !clientEmail.includes("@")) {
          return badRequest(`clients[${index}] has invalid clientEmail`);
        }

        const clientId = normalizeClientId(clientEmail);
        if (!clientId || clientId.length > 254) {
          return badRequest(`clients[${index}] has invalid clientId`);
        }

        const rowPolicyId = normalizePolicyId(row.policyId ?? defaultPolicyId);
        if (!rowPolicyId || !Object.prototype.hasOwnProperty.call(policyPresets, rowPolicyId)) {
          return badRequest(
            `clients[${index}].policyId must be one of: ${policyCatalog.policyOptions.join(", ")}`
          );
        }

        const rowAccessState = normalizeClientAccessState(row.accessState, "active");
        if (!["active", "blocked", "deleted"].includes(rowAccessState)) {
          return badRequest(`clients[${index}].accessState must be one of: active, blocked, deleted`);
        }

        if (seenClientIds.has(clientId)) {
          continue;
        }
        seenClientIds.add(clientId);
        dedupedRows.push({
          clientId,
          clientEmail,
          clientDisplayName: sanitizeClientDisplayName(row.clientDisplayName),
          accessState: rowAccessState,
          policyId: rowPolicyId
        });
      }

      const nowIso = new Date().toISOString();
      let createdCount = 0;
      let updatedCount = 0;
      for (const row of dedupedRows) {
        const existing = await deps.getClientProfile(clientProfilesTableName, advisorId, row.clientId);
        const next = {
          ...(existing ?? {}),
          advisorId,
          clientId: row.clientId,
          clientEmail: row.clientEmail,
          clientDisplayName:
            row.clientDisplayName ??
            existing?.clientDisplayName ??
            deriveClientDisplayNameFromEmail(row.clientEmail),
          accessState: row.accessState,
          policyId: row.policyId,
          admittedSource: existing?.admittedSource ?? "advisor_portal_import",
          admittedBy: existing?.admittedBy ?? advisorId,
          admittedAt: existing?.admittedAt ?? nowIso,
          createdAt: existing?.createdAt ?? nowIso,
          updatedAt: nowIso
        };
        await deps.putClientProfile(clientProfilesTableName, next);
        if (existing) {
          updatedCount += 1;
        } else {
          createdCount += 1;
        }
      }

      return jsonResponse(200, {
        advisorId,
        importedCount: dedupedRows.length,
        createdCount,
        updatedCount
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
        provider: "google",
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
      if (
        !stateItem ||
        stateItem.purpose !== "calendar_connection" ||
        (stateItem.provider && stateItem.provider !== "google")
      ) {
        return badRequest("Invalid or expired OAuth state");
      }
      const oauthAdvisorId = normalizeAdvisorId(stateItem.advisorId, advisorId);

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

      const tokenPayload = await exchangeGoogleCodeForTokens({
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
      const secretName = `/${appName}/${stage}/${oauthAdvisorId}/connections/${connectionId}`;
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
        advisorId: oauthAdvisorId,
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

    if ((method === "POST" || method === "GET") && rawPath === "/advisor/api/connections/microsoft/start") {
      if (!oauthStateTableName) {
        if (method === "GET") {
          return redirectAdvisorWithError(event, "OAUTH_STATE_TABLE_NAME is required");
        }

        return serverError("OAUTH_STATE_TABLE_NAME is required");
      }

      if (!microsoftAppSecretArn) {
        if (method === "GET") {
          return redirectAdvisorWithError(event, "Microsoft OAuth app is not configured in this environment yet.");
        }

        return badRequest("Microsoft OAuth app is not configured in this environment yet.");
      }

      let appSecret;
      try {
        appSecret = parseMicrosoftAppSecret(await deps.getSecretString(microsoftAppSecretArn));
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
        provider: "microsoft",
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: Math.floor((nowMs + 15 * 60 * 1000) / 1000)
      });

      const redirectUri = `${getBaseUrl(event)}/advisor/api/connections/microsoft/callback`;
      const authUrl = new URL(
        `https://login.microsoftonline.com/${encodeURIComponent(appSecret.tenantId)}/oauth2/v2.0/authorize`
      );
      authUrl.searchParams.set("client_id", appSecret.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("response_mode", "query");
      authUrl.searchParams.set("scope", "openid profile email offline_access User.Read Calendars.Read");
      authUrl.searchParams.set("prompt", "select_account");
      authUrl.searchParams.set("state", state);
      return redirectResponse(authUrl.toString());
    }

    if (method === "GET" && rawPath === "/advisor/api/connections/microsoft/callback") {
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
      if (
        !stateItem ||
        stateItem.purpose !== "calendar_connection" ||
        stateItem.provider !== "microsoft"
      ) {
        return badRequest("Invalid or expired OAuth state");
      }
      const oauthAdvisorId = normalizeAdvisorId(stateItem.advisorId, advisorId);
      await deps.deleteOauthState(oauthStateTableName, state);

      if (!microsoftAppSecretArn) {
        return badRequest("Microsoft OAuth app is not configured in this environment yet.");
      }

      let appSecret;
      try {
        appSecret = parseMicrosoftAppSecret(await deps.getSecretString(microsoftAppSecretArn));
      } catch (error) {
        return badRequest(error.message);
      }

      const redirectUri = `${getBaseUrl(event)}/advisor/api/connections/microsoft/callback`;
      const tokenPayload = await exchangeMicrosoftCodeForTokens({
        clientId: appSecret.clientId,
        clientSecret: appSecret.clientSecret,
        tenantId: appSecret.tenantId,
        code,
        redirectUri,
        fetchImpl: deps.fetchImpl
      });

      if (!tokenPayload.refresh_token) {
        return badRequest("Microsoft did not return refresh_token. Reconnect and ensure consent prompt is granted.");
      }

      const profile = tokenPayload.access_token
        ? await fetchMicrosoftUserProfile(tokenPayload.access_token, deps.fetchImpl)
        : { email: null };

      const nowIso = new Date().toISOString();
      const connectionId = `microsoft-${crypto.randomUUID()}`;
      const secretName = `/${appName}/${stage}/${oauthAdvisorId}/connections/${connectionId}`;
      const secretArn = await deps.createSecret(
        secretName,
        JSON.stringify({
          client_id: appSecret.clientId,
          client_secret: appSecret.clientSecret,
          tenant_id: appSecret.tenantId,
          refresh_token: tokenPayload.refresh_token,
          calendar_ids: ["primary"]
        })
      );

      await deps.putConnection(connectionsTableName, {
        advisorId: oauthAdvisorId,
        connectionId,
        provider: "microsoft",
        accountEmail: profile.email ?? "unknown@microsoft",
        status: "connected",
        isPrimary: true,
        secretArn,
        createdAt: nowIso,
        updatedAt: nowIso
      });

      return redirectResponse(`${getBaseUrl(event)}/advisor?connected=microsoft`);
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
