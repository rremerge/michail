import crypto from "node:crypto";

function encodeBase64Url(input) {
  return Buffer.from(input, "utf8").toString("base64url");
}

function decodeBase64Url(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function constantTimeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function parseAvailabilityLinkSecret(secretString) {
  const parsed = JSON.parse(secretString);
  const signingKey = String(parsed.signing_key ?? "").trim();
  if (!signingKey) {
    throw new Error("Availability link secret is missing signing_key");
  }

  return { signingKey };
}

export function createAvailabilityLinkToken(payload, signingKey) {
  const payloadEncoded = encodeBase64Url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", signingKey).update(payloadEncoded).digest("base64url");
  return `${payloadEncoded}.${signature}`;
}

export function validateAvailabilityLinkToken(token, signingKey, nowMs = Date.now()) {
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

  const advisorId = String(payload.advisorId ?? "").trim();
  const issuedAtMs = Number(payload.issuedAtMs ?? 0);
  const expiresAtMs = Number(payload.expiresAtMs ?? 0);
  if (!advisorId || !Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    return null;
  }

  if (expiresAtMs <= nowMs || expiresAtMs <= issuedAtMs) {
    return null;
  }

  const clientTimezone = String(payload.clientTimezone ?? "").trim() || null;
  const durationMinutes = Number(payload.durationMinutes ?? 0);

  return {
    advisorId,
    issuedAtMs,
    expiresAtMs,
    clientTimezone,
    durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : null
  };
}
