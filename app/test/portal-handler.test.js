import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createPortalHandler } from "../src/portal-handler.js";

function toBasicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function createSessionToken(payload, signingKey) {
  const payloadEncoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", signingKey).update(payloadEncoded).digest("base64url");
  return `${payloadEncoded}.${signature}`;
}

test("advisor portal home serves html", async () => {
  const handler = createPortalHandler({
    async listConnections() {
      return [];
    }
  });

  const previousConnectionsTable = process.env.CONNECTIONS_TABLE_NAME;
  process.env.CONNECTIONS_TABLE_NAME = "ConnectionsTable";

  try {
    const response = await handler({
      requestContext: {
        http: { method: "GET" }
      },
      rawPath: "/advisor"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /text\/html/);
    assert.match(response.body, /Connected Calendars/);
  } finally {
    if (previousConnectionsTable === undefined) {
      delete process.env.CONNECTIONS_TABLE_NAME;
    } else {
      process.env.CONNECTIONS_TABLE_NAME = previousConnectionsTable;
    }
  }
});

test("advisor portal blocks requests when basic auth is enabled and credentials are missing", async () => {
  const handler = createPortalHandler({
    async getSecretString() {
      return JSON.stringify({
        username: "advisor",
        password: "test-password"
      });
    }
  });

  const previousConnectionsTable = process.env.CONNECTIONS_TABLE_NAME;
  const previousAuthMode = process.env.ADVISOR_PORTAL_AUTH_MODE;
  const previousAuthSecretArn = process.env.ADVISOR_PORTAL_AUTH_SECRET_ARN;
  process.env.CONNECTIONS_TABLE_NAME = "ConnectionsTable";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "secret_basic";
  process.env.ADVISOR_PORTAL_AUTH_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:portal-auth";

  try {
    const response = await handler({
      requestContext: {
        http: { method: "GET" }
      },
      rawPath: "/advisor"
    });

    assert.equal(response.statusCode, 401);
    assert.match(response.headers["www-authenticate"], /Basic/);
  } finally {
    if (previousConnectionsTable === undefined) {
      delete process.env.CONNECTIONS_TABLE_NAME;
    } else {
      process.env.CONNECTIONS_TABLE_NAME = previousConnectionsTable;
    }

    if (previousAuthMode === undefined) {
      delete process.env.ADVISOR_PORTAL_AUTH_MODE;
    } else {
      process.env.ADVISOR_PORTAL_AUTH_MODE = previousAuthMode;
    }

    if (previousAuthSecretArn === undefined) {
      delete process.env.ADVISOR_PORTAL_AUTH_SECRET_ARN;
    } else {
      process.env.ADVISOR_PORTAL_AUTH_SECRET_ARN = previousAuthSecretArn;
    }
  }
});

test("advisor portal allows requests with valid basic auth credentials", async () => {
  const handler = createPortalHandler({
    async getSecretString() {
      return JSON.stringify({
        username: "advisor",
        password: "test-password"
      });
    }
  });

  const previousConnectionsTable = process.env.CONNECTIONS_TABLE_NAME;
  const previousAuthMode = process.env.ADVISOR_PORTAL_AUTH_MODE;
  const previousAuthSecretArn = process.env.ADVISOR_PORTAL_AUTH_SECRET_ARN;
  process.env.CONNECTIONS_TABLE_NAME = "ConnectionsTable";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "secret_basic";
  process.env.ADVISOR_PORTAL_AUTH_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:portal-auth";

  try {
    const response = await handler({
      headers: {
        authorization: toBasicAuthorization("advisor", "test-password")
      },
      requestContext: {
        http: { method: "GET" }
      },
      rawPath: "/advisor"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Connected Calendars/);
  } finally {
    if (previousConnectionsTable === undefined) {
      delete process.env.CONNECTIONS_TABLE_NAME;
    } else {
      process.env.CONNECTIONS_TABLE_NAME = previousConnectionsTable;
    }

    if (previousAuthMode === undefined) {
      delete process.env.ADVISOR_PORTAL_AUTH_MODE;
    } else {
      process.env.ADVISOR_PORTAL_AUTH_MODE = previousAuthMode;
    }

    if (previousAuthSecretArn === undefined) {
      delete process.env.ADVISOR_PORTAL_AUTH_SECRET_ARN;
    } else {
      process.env.ADVISOR_PORTAL_AUTH_SECRET_ARN = previousAuthSecretArn;
    }
  }
});

test("advisor portal redirects to Google login when google_oauth auth is enabled", async () => {
  const handler = createPortalHandler({
    async getSecretString() {
      return JSON.stringify({
        signing_key: "test-signing-key"
      });
    }
  });

  const previousConnectionsTable = process.env.CONNECTIONS_TABLE_NAME;
  const previousAuthMode = process.env.ADVISOR_PORTAL_AUTH_MODE;
  const previousSessionSecretArn = process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN;

  process.env.CONNECTIONS_TABLE_NAME = "ConnectionsTable";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "google_oauth";
  process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:portal-session";

  try {
    const response = await handler({
      requestContext: {
        domainName: "xytaxmumc3.execute-api.us-east-1.amazonaws.com",
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/advisor"
    });

    assert.equal(response.statusCode, 302);
    assert.equal(
      response.headers.location,
      "https://xytaxmumc3.execute-api.us-east-1.amazonaws.com/dev/advisor/auth/google/start?returnTo=%2Fadvisor"
    );
  } finally {
    if (previousConnectionsTable === undefined) {
      delete process.env.CONNECTIONS_TABLE_NAME;
    } else {
      process.env.CONNECTIONS_TABLE_NAME = previousConnectionsTable;
    }

    if (previousAuthMode === undefined) {
      delete process.env.ADVISOR_PORTAL_AUTH_MODE;
    } else {
      process.env.ADVISOR_PORTAL_AUTH_MODE = previousAuthMode;
    }

    if (previousSessionSecretArn === undefined) {
      delete process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN;
    } else {
      process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN = previousSessionSecretArn;
    }
  }
});

test("advisor auth callback creates session cookie for allowed advisor email", async () => {
  const handler = createPortalHandler({
    async getSecretString(secretArn) {
      if (secretArn.endsWith(":secret:portal-app")) {
        return JSON.stringify({
          client_id: "google-client-id",
          client_secret: "google-client-secret"
        });
      }

      if (secretArn.endsWith(":secret:portal-session")) {
        return JSON.stringify({
          signing_key: "test-signing-key"
        });
      }

      throw new Error(`unexpected secret arn: ${secretArn}`);
    },
    async getOauthState() {
      return {
        advisorId: "manoj",
        purpose: "portal_login",
        returnTo: "/advisor"
      };
    },
    async deleteOauthState() {},
    fetchImpl: async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return {
          ok: true,
          async json() {
            return {
              access_token: "test-access-token"
            };
          }
        };
      }

      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return {
          ok: true,
          async json() {
            return {
              email: "manoj@rremerge.com"
            };
          }
        };
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }
  });

  const previousAuthMode = process.env.ADVISOR_PORTAL_AUTH_MODE;
  const previousOauthStateTable = process.env.OAUTH_STATE_TABLE_NAME;
  const previousAppSecretArn = process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
  const previousSessionSecretArn = process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN;
  const previousAllowedEmail = process.env.ADVISOR_ALLOWED_EMAIL;

  process.env.ADVISOR_PORTAL_AUTH_MODE = "google_oauth";
  process.env.OAUTH_STATE_TABLE_NAME = "OAuthStateTable";
  process.env.GOOGLE_OAUTH_APP_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:portal-app";
  process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:portal-session";
  process.env.ADVISOR_ALLOWED_EMAIL = "manoj@rremerge.com";

  try {
    const response = await handler({
      queryStringParameters: {
        code: "google-code",
        state: "oauth-state"
      },
      requestContext: {
        domainName: "xytaxmumc3.execute-api.us-east-1.amazonaws.com",
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/advisor/auth/google/callback"
    });

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, "https://xytaxmumc3.execute-api.us-east-1.amazonaws.com/dev/advisor");
    assert.ok(Array.isArray(response.cookies));
    assert.match(response.cookies[0], /^advisor_portal_session=/);
  } finally {
    if (previousAuthMode === undefined) {
      delete process.env.ADVISOR_PORTAL_AUTH_MODE;
    } else {
      process.env.ADVISOR_PORTAL_AUTH_MODE = previousAuthMode;
    }

    if (previousOauthStateTable === undefined) {
      delete process.env.OAUTH_STATE_TABLE_NAME;
    } else {
      process.env.OAUTH_STATE_TABLE_NAME = previousOauthStateTable;
    }

    if (previousAppSecretArn === undefined) {
      delete process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
    } else {
      process.env.GOOGLE_OAUTH_APP_SECRET_ARN = previousAppSecretArn;
    }

    if (previousSessionSecretArn === undefined) {
      delete process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN;
    } else {
      process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN = previousSessionSecretArn;
    }

    if (previousAllowedEmail === undefined) {
      delete process.env.ADVISOR_ALLOWED_EMAIL;
    } else {
      process.env.ADVISOR_ALLOWED_EMAIL = previousAllowedEmail;
    }
  }
});

test("advisor portal accepts session token from API Gateway cookies array", async () => {
  const signingKey = "test-signing-key";
  const handler = createPortalHandler({
    async getSecretString() {
      return JSON.stringify({
        signing_key: signingKey
      });
    },
    async listConnections() {
      return [];
    }
  });

  const previousConnectionsTable = process.env.CONNECTIONS_TABLE_NAME;
  const previousAuthMode = process.env.ADVISOR_PORTAL_AUTH_MODE;
  const previousSessionSecretArn = process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN;
  process.env.CONNECTIONS_TABLE_NAME = "ConnectionsTable";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "google_oauth";
  process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:portal-session";

  const sessionToken = createSessionToken(
    {
      email: "manoj@rremerge.com",
      expiresAtMs: Date.now() + 5 * 60 * 1000
    },
    signingKey
  );

  try {
    const response = await handler({
      cookies: [`advisor_portal_session=${sessionToken}`],
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/advisor"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Connected Calendars/);
  } finally {
    if (previousConnectionsTable === undefined) {
      delete process.env.CONNECTIONS_TABLE_NAME;
    } else {
      process.env.CONNECTIONS_TABLE_NAME = previousConnectionsTable;
    }

    if (previousAuthMode === undefined) {
      delete process.env.ADVISOR_PORTAL_AUTH_MODE;
    } else {
      process.env.ADVISOR_PORTAL_AUTH_MODE = previousAuthMode;
    }

    if (previousSessionSecretArn === undefined) {
      delete process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN;
    } else {
      process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN = previousSessionSecretArn;
    }
  }
});

test("advisor portal normalizes stage-prefixed routes", async () => {
  const handler = createPortalHandler({
    async listConnections() {
      return [];
    }
  });

  const previousConnectionsTable = process.env.CONNECTIONS_TABLE_NAME;
  process.env.CONNECTIONS_TABLE_NAME = "ConnectionsTable";

  try {
    const response = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/advisor"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Connected Calendars/);
  } finally {
    if (previousConnectionsTable === undefined) {
      delete process.env.CONNECTIONS_TABLE_NAME;
    } else {
      process.env.CONNECTIONS_TABLE_NAME = previousConnectionsTable;
    }
  }
});

test("advisor portal can create and list mock connection", async () => {
  const stored = [];
  const handler = createPortalHandler({
    async putConnection(_tableName, item) {
      stored.push(item);
    },
    async listConnections() {
      return stored;
    }
  });

  const previousConnectionsTable = process.env.CONNECTIONS_TABLE_NAME;
  const previousAdvisorId = process.env.ADVISOR_ID;
  process.env.CONNECTIONS_TABLE_NAME = "ConnectionsTable";
  process.env.ADVISOR_ID = "manoj";

  try {
    const createResponse = await handler({
      requestContext: {
        http: { method: "POST" }
      },
      rawPath: "/advisor/api/connections/mock"
    });

    assert.equal(createResponse.statusCode, 201);
    const createdPayload = JSON.parse(createResponse.body);
    assert.equal(createdPayload.provider, "mock");

    const listResponse = await handler({
      requestContext: {
        http: { method: "GET" }
      },
      rawPath: "/advisor/api/connections"
    });

    assert.equal(listResponse.statusCode, 200);
    const listPayload = JSON.parse(listResponse.body);
    assert.equal(listPayload.connections.length, 1);
    assert.equal(listPayload.connections[0].provider, "mock");
  } finally {
    if (previousConnectionsTable === undefined) {
      delete process.env.CONNECTIONS_TABLE_NAME;
    } else {
      process.env.CONNECTIONS_TABLE_NAME = previousConnectionsTable;
    }

    if (previousAdvisorId === undefined) {
      delete process.env.ADVISOR_ID;
    } else {
      process.env.ADVISOR_ID = previousAdvisorId;
    }
  }
});

test("advisor portal google start returns 400 when app credentials are missing", async () => {
  const handler = createPortalHandler({
    async getSecretString() {
      return JSON.stringify({
        client_id: "",
        client_secret: ""
      });
    },
    async putOauthState() {
      throw new Error("putOauthState should not be called when credentials are missing");
    }
  });

  const previousConnectionsTable = process.env.CONNECTIONS_TABLE_NAME;
  const previousOauthStateTable = process.env.OAUTH_STATE_TABLE_NAME;
  const previousAppSecretArn = process.env.GOOGLE_OAUTH_APP_SECRET_ARN;

  process.env.CONNECTIONS_TABLE_NAME = "ConnectionsTable";
  process.env.OAUTH_STATE_TABLE_NAME = "OAuthStateTable";
  process.env.GOOGLE_OAUTH_APP_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:test";

  try {
    const response = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "POST" }
      },
      rawPath: "/dev/advisor/api/connections/google/start"
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.match(body.error, /missing client_id or client_secret/);
  } finally {
    if (previousConnectionsTable === undefined) {
      delete process.env.CONNECTIONS_TABLE_NAME;
    } else {
      process.env.CONNECTIONS_TABLE_NAME = previousConnectionsTable;
    }

    if (previousOauthStateTable === undefined) {
      delete process.env.OAUTH_STATE_TABLE_NAME;
    } else {
      process.env.OAUTH_STATE_TABLE_NAME = previousOauthStateTable;
    }

    if (previousAppSecretArn === undefined) {
      delete process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
    } else {
      process.env.GOOGLE_OAUTH_APP_SECRET_ARN = previousAppSecretArn;
    }
  }
});

test("advisor portal google start redirects browser to Google login", async () => {
  let capturedState = null;
  const handler = createPortalHandler({
    async getSecretString() {
      return JSON.stringify({
        client_id: "google-client-id",
        client_secret: "google-client-secret"
      });
    },
    async putOauthState(_tableName, state) {
      capturedState = state;
    }
  });

  const previousConnectionsTable = process.env.CONNECTIONS_TABLE_NAME;
  const previousOauthStateTable = process.env.OAUTH_STATE_TABLE_NAME;
  const previousAppSecretArn = process.env.GOOGLE_OAUTH_APP_SECRET_ARN;

  process.env.CONNECTIONS_TABLE_NAME = "ConnectionsTable";
  process.env.OAUTH_STATE_TABLE_NAME = "OAuthStateTable";
  process.env.GOOGLE_OAUTH_APP_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:test";

  try {
    const response = await handler({
      requestContext: {
        domainName: "xytaxmumc3.execute-api.us-east-1.amazonaws.com",
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/advisor/api/connections/google/start"
    });

    assert.equal(response.statusCode, 302);
    assert.ok(response.headers.location.startsWith("https://accounts.google.com/o/oauth2/v2/auth"));

    const redirectUrl = new URL(response.headers.location);
    assert.equal(redirectUrl.searchParams.get("client_id"), "google-client-id");
    assert.equal(
      redirectUrl.searchParams.get("redirect_uri"),
      "https://xytaxmumc3.execute-api.us-east-1.amazonaws.com/dev/advisor/api/connections/google/callback"
    );
    assert.equal(redirectUrl.searchParams.get("response_type"), "code");
    assert.equal(redirectUrl.searchParams.get("access_type"), "offline");
    assert.equal(redirectUrl.searchParams.get("prompt"), "consent");
    assert.equal(redirectUrl.searchParams.get("state"), capturedState);
    assert.ok(capturedState);
  } finally {
    if (previousConnectionsTable === undefined) {
      delete process.env.CONNECTIONS_TABLE_NAME;
    } else {
      process.env.CONNECTIONS_TABLE_NAME = previousConnectionsTable;
    }

    if (previousOauthStateTable === undefined) {
      delete process.env.OAUTH_STATE_TABLE_NAME;
    } else {
      process.env.OAUTH_STATE_TABLE_NAME = previousOauthStateTable;
    }

    if (previousAppSecretArn === undefined) {
      delete process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
    } else {
      process.env.GOOGLE_OAUTH_APP_SECRET_ARN = previousAppSecretArn;
    }
  }
});

test("advisor portal trace lookup returns metadata and diagnosis", async () => {
  const requestId = "123e4567-e89b-12d3-a456-426614174000";
  const handler = createPortalHandler({
    async getTrace(tableName, suppliedRequestId) {
      assert.equal(tableName, "TraceTable");
      assert.equal(suppliedRequestId, requestId);
      return {
        requestId,
        responseId: "123e4567-e89b-12d3-a456-426614174001",
        advisorId: "manoj",
        status: "failed",
        errorCode: "CALENDAR_LOOKUP_FAILED",
        providerStatus: "error",
        llmStatus: "fallback",
        latencyMs: 35000,
        suggestionCount: 0,
        updatedAt: "2026-02-16T00:00:00.000Z"
      };
    }
  });

  const previousTraceTableName = process.env.TRACE_TABLE_NAME;
  const previousAuthMode = process.env.ADVISOR_PORTAL_AUTH_MODE;
  const previousAdvisorId = process.env.ADVISOR_ID;
  process.env.TRACE_TABLE_NAME = "TraceTable";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.ADVISOR_ID = "manoj";

  try {
    const response = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: `/dev/advisor/api/traces/${requestId}`
    });

    assert.equal(response.statusCode, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.trace.requestId, requestId);
    assert.equal(payload.trace.status, "failed");
    assert.deepEqual(payload.diagnosis.categories.includes("processing_failed"), true);
    assert.deepEqual(payload.diagnosis.categories.includes("slow_response"), true);
  } finally {
    if (previousTraceTableName === undefined) {
      delete process.env.TRACE_TABLE_NAME;
    } else {
      process.env.TRACE_TABLE_NAME = previousTraceTableName;
    }

    if (previousAuthMode === undefined) {
      delete process.env.ADVISOR_PORTAL_AUTH_MODE;
    } else {
      process.env.ADVISOR_PORTAL_AUTH_MODE = previousAuthMode;
    }

    if (previousAdvisorId === undefined) {
      delete process.env.ADVISOR_ID;
    } else {
      process.env.ADVISOR_ID = previousAdvisorId;
    }
  }
});

test("advisor portal can submit feedback for a trace", async () => {
  const requestId = "123e4567-e89b-12d3-a456-426614174000";
  const responseId = "123e4567-e89b-12d3-a456-426614174001";
  const updates = [];
  const handler = createPortalHandler({
    async updateTraceFeedback(tableName, update) {
      assert.equal(tableName, "TraceTable");
      updates.push(update);
      return {
        requestId: update.requestId,
        responseId: update.responseId,
        advisorId: "manoj"
      };
    }
  });

  const previousTraceTableName = process.env.TRACE_TABLE_NAME;
  const previousAuthMode = process.env.ADVISOR_PORTAL_AUTH_MODE;
  const previousAdvisorId = process.env.ADVISOR_ID;
  process.env.TRACE_TABLE_NAME = "TraceTable";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.ADVISOR_ID = "manoj";

  try {
    const response = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "POST" }
      },
      rawPath: `/dev/advisor/api/traces/${requestId}/feedback`,
      body: JSON.stringify({
        responseId,
        feedbackType: "odd",
        feedbackReason: "tone_quality"
      })
    });

    assert.equal(response.statusCode, 200);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].requestId, requestId);
    assert.equal(updates[0].responseId, responseId);
    assert.equal(updates[0].feedbackType, "odd");
    assert.equal(updates[0].feedbackReason, "tone_quality");
    assert.equal(updates[0].feedbackSource, "advisor");
  } finally {
    if (previousTraceTableName === undefined) {
      delete process.env.TRACE_TABLE_NAME;
    } else {
      process.env.TRACE_TABLE_NAME = previousTraceTableName;
    }

    if (previousAuthMode === undefined) {
      delete process.env.ADVISOR_PORTAL_AUTH_MODE;
    } else {
      process.env.ADVISOR_PORTAL_AUTH_MODE = previousAuthMode;
    }

    if (previousAdvisorId === undefined) {
      delete process.env.ADVISOR_ID;
    } else {
      process.env.ADVISOR_ID = previousAdvisorId;
    }
  }
});
