import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DateTime } from "luxon";
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
    assert.match(response.body, /id="portalBrandLogo"/);
    assert.match(response.body, /Copyright \(C\) 2026\. RR Emerge LLC/);
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

test("advisor auth callback seeds advisor settings defaults from google login", async () => {
  const settingsWrites = [];
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
    async getAdvisorSettings(tableName, advisorId) {
      assert.equal(tableName, "AdvisorSettingsTable");
      assert.equal(advisorId, "manoj@rremerge.com");
      return null;
    },
    async putAdvisorSettings(tableName, item) {
      assert.equal(tableName, "AdvisorSettingsTable");
      settingsWrites.push(item);
    },
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
              email: "manoj@rremerge.com",
              name: "Manoj Apte"
            };
          }
        };
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }
  });

  const previousValues = {
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    OAUTH_STATE_TABLE_NAME: process.env.OAUTH_STATE_TABLE_NAME,
    GOOGLE_OAUTH_APP_SECRET_ARN: process.env.GOOGLE_OAUTH_APP_SECRET_ARN,
    ADVISOR_PORTAL_SESSION_SECRET_ARN: process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN,
    ADVISOR_ALLOWED_EMAIL: process.env.ADVISOR_ALLOWED_EMAIL,
    ADVISOR_SETTINGS_TABLE_NAME: process.env.ADVISOR_SETTINGS_TABLE_NAME
  };

  process.env.ADVISOR_PORTAL_AUTH_MODE = "google_oauth";
  process.env.OAUTH_STATE_TABLE_NAME = "OAuthStateTable";
  process.env.GOOGLE_OAUTH_APP_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:portal-app";
  process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:portal-session";
  process.env.ADVISOR_ALLOWED_EMAIL = "manoj@rremerge.com";
  process.env.ADVISOR_SETTINGS_TABLE_NAME = "AdvisorSettingsTable";

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
    assert.equal(settingsWrites.length, 1);
    assert.equal(settingsWrites[0].advisorId, "manoj@rremerge.com");
    assert.equal(settingsWrites[0].agentEmail, "manoj.agent@agent.letsconnect.ai");
    assert.equal(settingsWrites[0].inviteEmail, "manoj@rremerge.com");
    assert.equal(settingsWrites[0].preferredName, "Manoj Apte");
    assert.equal(settingsWrites[0].timezone, "America/Los_Angeles");
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("advisor auth callback resolves default agent email collisions", async () => {
  const settingsWrites = [];
  const checkedAgentEmails = [];
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
    async getAdvisorSettings() {
      return null;
    },
    async getAdvisorSettingsByAgentEmail(_tableName, agentEmail) {
      checkedAgentEmails.push(agentEmail);
      if (agentEmail === "manoj.agent@agent.letsconnect.ai") {
        return {
          advisorId: "already-used"
        };
      }

      return null;
    },
    async putAdvisorSettings(_tableName, item) {
      settingsWrites.push(item);
    },
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
              email: "manoj@rremerge.com",
              name: "Manoj Apte"
            };
          }
        };
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }
  });

  const previousValues = {
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    OAUTH_STATE_TABLE_NAME: process.env.OAUTH_STATE_TABLE_NAME,
    GOOGLE_OAUTH_APP_SECRET_ARN: process.env.GOOGLE_OAUTH_APP_SECRET_ARN,
    ADVISOR_PORTAL_SESSION_SECRET_ARN: process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN,
    ADVISOR_ALLOWED_EMAIL: process.env.ADVISOR_ALLOWED_EMAIL,
    ADVISOR_SETTINGS_TABLE_NAME: process.env.ADVISOR_SETTINGS_TABLE_NAME
  };

  process.env.ADVISOR_PORTAL_AUTH_MODE = "google_oauth";
  process.env.OAUTH_STATE_TABLE_NAME = "OAuthStateTable";
  process.env.GOOGLE_OAUTH_APP_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:portal-app";
  process.env.ADVISOR_PORTAL_SESSION_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:portal-session";
  process.env.ADVISOR_ALLOWED_EMAIL = "manoj@rremerge.com";
  process.env.ADVISOR_SETTINGS_TABLE_NAME = "AdvisorSettingsTable";

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
    assert.deepEqual(checkedAgentEmails, ["manoj.agent@agent.letsconnect.ai", "manoj.agent.1@agent.letsconnect.ai"]);
    assert.equal(settingsWrites.length, 1);
    assert.equal(settingsWrites[0].agentEmail, "manoj.agent.1@agent.letsconnect.ai");
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
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

test("advisor portal lists client directory metadata", async () => {
  const handler = createPortalHandler({
    async listClientProfiles(tableName, advisorId) {
      assert.equal(tableName, "ClientProfilesTable");
      assert.equal(advisorId, "manoj");
      return [
        {
          advisorId,
          clientId: "client@example.com",
          clientEmail: "client@example.com",
          clientDisplayName: "Client Example",
          accessState: "active",
          policyId: "default",
          firstInteractionAt: "2026-02-01T00:00:00.000Z",
          lastInteractionAt: "2026-02-16T00:00:00.000Z",
          emailAgentCount: 3,
          availabilityWebCount: 2,
          totalInteractionCount: 5,
          updatedAt: "2026-02-16T00:00:00.000Z"
        }
      ];
    }
  });

  const previousValues = {
    CLIENT_PROFILES_TABLE_NAME: process.env.CLIENT_PROFILES_TABLE_NAME,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    ADVISOR_ID: process.env.ADVISOR_ID,
    CLIENT_POLICY_PRESETS_JSON: process.env.CLIENT_POLICY_PRESETS_JSON
  };

  process.env.CLIENT_PROFILES_TABLE_NAME = "ClientProfilesTable";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.ADVISOR_ID = "manoj";
  process.env.CLIENT_POLICY_PRESETS_JSON = '{"default":["Tue","Wed"],"weekend":["Sat","Sun"],"monday":["Mon"]}';

  try {
    const response = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/advisor/api/clients"
    });

    assert.equal(response.statusCode, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.clients.length, 1);
    assert.equal(payload.clients[0].clientId, "client@example.com");
    assert.equal(payload.clients[0].totalInteractionCount, 5);
    assert.deepEqual(payload.policyOptions.includes("weekend"), true);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("advisor portal lists policy presets including custom policies", async () => {
  const handler = createPortalHandler({
    async listPolicyPresets(tableName, advisorId) {
      assert.equal(tableName, "PolicyPresetsTable");
      assert.equal(advisorId, "manoj");
      return [
        {
          advisorId,
          policyId: "founders",
          advisingDays: ["Thu", "Fri"],
          createdAt: "2026-02-18T00:00:00.000Z",
          updatedAt: "2026-02-18T00:00:00.000Z"
        }
      ];
    }
  });

  const previousValues = {
    POLICY_PRESETS_TABLE_NAME: process.env.POLICY_PRESETS_TABLE_NAME,
    CLIENT_POLICY_PRESETS_JSON: process.env.CLIENT_POLICY_PRESETS_JSON,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    ADVISOR_ID: process.env.ADVISOR_ID
  };

  process.env.POLICY_PRESETS_TABLE_NAME = "PolicyPresetsTable";
  process.env.CLIENT_POLICY_PRESETS_JSON = '{"default":["Tue","Wed"],"weekend":["Sat","Sun"],"monday":["Mon"]}';
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.ADVISOR_ID = "manoj";

  try {
    const response = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/advisor/api/policies"
    });

    assert.equal(response.statusCode, 200);
    const payload = JSON.parse(response.body);
    assert.deepEqual(payload.policyOptions.includes("founders"), true);
    const foundersPolicy = payload.policies.find((item) => item.policyId === "founders");
    assert.ok(foundersPolicy);
    assert.deepEqual(foundersPolicy.advisingDays, ["Thu", "Fri"]);
    assert.equal(foundersPolicy.source, "custom");
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("advisor portal can create update and delete custom policy presets", async () => {
  const putWrites = [];
  const deleteWrites = [];
  const customPolicies = [];
  const handler = createPortalHandler({
    async listPolicyPresets(tableName, advisorId) {
      assert.equal(tableName, "PolicyPresetsTable");
      assert.equal(advisorId, "manoj");
      return customPolicies.map((item) => ({ ...item }));
    },
    async putPolicyPreset(tableName, item) {
      assert.equal(tableName, "PolicyPresetsTable");
      putWrites.push(item);
      const existingIndex = customPolicies.findIndex((policy) => policy.policyId === item.policyId);
      if (existingIndex >= 0) {
        customPolicies[existingIndex] = { ...item };
      } else {
        customPolicies.push({ ...item });
      }
    },
    async deletePolicyPreset(tableName, advisorId, policyId) {
      assert.equal(tableName, "PolicyPresetsTable");
      assert.equal(advisorId, "manoj");
      deleteWrites.push(policyId);
      const nextPolicies = customPolicies.filter((item) => item.policyId !== policyId);
      customPolicies.length = 0;
      customPolicies.push(...nextPolicies);
    },
    async listClientProfiles() {
      return [];
    }
  });

  const previousValues = {
    POLICY_PRESETS_TABLE_NAME: process.env.POLICY_PRESETS_TABLE_NAME,
    CLIENT_POLICY_PRESETS_JSON: process.env.CLIENT_POLICY_PRESETS_JSON,
    CLIENT_PROFILES_TABLE_NAME: process.env.CLIENT_PROFILES_TABLE_NAME,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    ADVISOR_ID: process.env.ADVISOR_ID
  };

  process.env.POLICY_PRESETS_TABLE_NAME = "PolicyPresetsTable";
  process.env.CLIENT_POLICY_PRESETS_JSON = '{"default":["Tue","Wed"],"weekend":["Sat","Sun"],"monday":["Mon"]}';
  process.env.CLIENT_PROFILES_TABLE_NAME = "ClientProfilesTable";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.ADVISOR_ID = "manoj";

  try {
    const createResponse = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "POST" }
      },
      rawPath: "/dev/advisor/api/policies",
      body: JSON.stringify({
        policyId: "founders",
        advisingDays: ["Thu", "Fri"]
      })
    });

    assert.equal(createResponse.statusCode, 201);
    assert.equal(putWrites.length, 1);
    assert.equal(putWrites[0].policyId, "founders");
    assert.deepEqual(putWrites[0].advisingDays, ["Thu", "Fri"]);

    const updateResponse = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "PATCH" }
      },
      rawPath: "/dev/advisor/api/policies/founders",
      body: JSON.stringify({
        advisingDays: ["Fri"]
      })
    });

    assert.equal(updateResponse.statusCode, 200);
    assert.equal(putWrites.length, 2);
    assert.deepEqual(putWrites[1].advisingDays, ["Fri"]);

    const deleteResponse = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "DELETE" }
      },
      rawPath: "/dev/advisor/api/policies/founders"
    });

    assert.equal(deleteResponse.statusCode, 200);
    assert.deepEqual(deleteWrites, ["founders"]);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("advisor portal updates client access state and policy", async () => {
  const writes = [];
  const handler = createPortalHandler({
    async getClientProfile(tableName, advisorId, clientId) {
      assert.equal(tableName, "ClientProfilesTable");
      assert.equal(advisorId, "manoj");
      assert.equal(clientId, "client@example.com");
      return {
        advisorId,
        clientId,
        clientEmail: clientId,
        clientDisplayName: "Client Example",
        accessState: "active",
        policyId: "default",
        firstInteractionAt: "2026-02-01T00:00:00.000Z",
        lastInteractionAt: "2026-02-16T00:00:00.000Z",
        emailAgentCount: 3,
        availabilityWebCount: 2,
        totalInteractionCount: 5
      };
    },
    async putClientProfile(tableName, item) {
      assert.equal(tableName, "ClientProfilesTable");
      writes.push(item);
    }
  });

  const previousValues = {
    CLIENT_PROFILES_TABLE_NAME: process.env.CLIENT_PROFILES_TABLE_NAME,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    ADVISOR_ID: process.env.ADVISOR_ID,
    CLIENT_POLICY_PRESETS_JSON: process.env.CLIENT_POLICY_PRESETS_JSON
  };

  process.env.CLIENT_PROFILES_TABLE_NAME = "ClientProfilesTable";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.ADVISOR_ID = "manoj";
  process.env.CLIENT_POLICY_PRESETS_JSON = '{"default":["Tue","Wed"],"weekend":["Sat","Sun"],"monday":["Mon"]}';

  try {
    const response = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "PATCH" }
      },
      rawPath: "/dev/advisor/api/clients/client%40example.com",
      body: JSON.stringify({
        accessState: "deleted",
        policyId: "weekend",
        advisingDaysOverride: ["Sat", "Sun"]
      })
    });

    assert.equal(response.statusCode, 200);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].accessState, "deleted");
    assert.equal(writes[0].policyId, "weekend");
    assert.deepEqual(writes[0].advisingDaysOverride, ["Sat", "Sun"]);
    const payload = JSON.parse(response.body);
    assert.equal(payload.client.accessState, "deleted");
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("advisor portal updates client policy using advisor-defined custom policy", async () => {
  const writes = [];
  const handler = createPortalHandler({
    async listPolicyPresets(tableName, advisorId) {
      assert.equal(tableName, "PolicyPresetsTable");
      assert.equal(advisorId, "manoj");
      return [
        {
          advisorId,
          policyId: "founders",
          advisingDays: ["Thu", "Fri"]
        }
      ];
    },
    async getClientProfile() {
      return {
        advisorId: "manoj",
        clientId: "client@example.com",
        clientEmail: "client@example.com",
        clientDisplayName: "Client Example",
        accessState: "active",
        policyId: "default"
      };
    },
    async putClientProfile(tableName, item) {
      assert.equal(tableName, "ClientProfilesTable");
      writes.push(item);
    }
  });

  const previousValues = {
    CLIENT_PROFILES_TABLE_NAME: process.env.CLIENT_PROFILES_TABLE_NAME,
    POLICY_PRESETS_TABLE_NAME: process.env.POLICY_PRESETS_TABLE_NAME,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    ADVISOR_ID: process.env.ADVISOR_ID,
    CLIENT_POLICY_PRESETS_JSON: process.env.CLIENT_POLICY_PRESETS_JSON
  };

  process.env.CLIENT_PROFILES_TABLE_NAME = "ClientProfilesTable";
  process.env.POLICY_PRESETS_TABLE_NAME = "PolicyPresetsTable";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.ADVISOR_ID = "manoj";
  process.env.CLIENT_POLICY_PRESETS_JSON = '{"default":["Tue","Wed"],"weekend":["Sat","Sun"],"monday":["Mon"]}';

  try {
    const response = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "PATCH" }
      },
      rawPath: "/dev/advisor/api/clients/client%40example.com",
      body: JSON.stringify({
        policyId: "founders"
      })
    });

    assert.equal(response.statusCode, 200);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].policyId, "founders");
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("advisor portal can add a client to admission allowlist", async () => {
  const writes = [];
  const handler = createPortalHandler({
    async getClientProfile(tableName, advisorId, clientId) {
      assert.equal(tableName, "ClientProfilesTable");
      assert.equal(advisorId, "manoj");
      assert.equal(clientId, "newclient@example.com");
      return null;
    },
    async putClientProfile(tableName, item) {
      assert.equal(tableName, "ClientProfilesTable");
      writes.push(item);
    }
  });

  const previousValues = {
    CLIENT_PROFILES_TABLE_NAME: process.env.CLIENT_PROFILES_TABLE_NAME,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    ADVISOR_ID: process.env.ADVISOR_ID,
    CLIENT_POLICY_PRESETS_JSON: process.env.CLIENT_POLICY_PRESETS_JSON
  };

  process.env.CLIENT_PROFILES_TABLE_NAME = "ClientProfilesTable";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.ADVISOR_ID = "manoj";
  process.env.CLIENT_POLICY_PRESETS_JSON = '{"default":["Tue","Wed"],"weekend":["Sat","Sun"],"monday":["Mon"]}';

  try {
    const response = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "POST" }
      },
      rawPath: "/dev/advisor/api/clients",
      body: JSON.stringify({
        clientEmail: "newclient@example.com",
        clientDisplayName: "New Client",
        policyId: "weekend"
      })
    });

    assert.equal(response.statusCode, 201);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].clientId, "newclient@example.com");
    assert.equal(writes[0].clientEmail, "newclient@example.com");
    assert.equal(writes[0].policyId, "weekend");
    assert.equal(writes[0].accessState, "active");
    assert.equal(writes[0].admittedSource, "advisor_portal");
    const payload = JSON.parse(response.body);
    assert.equal(payload.created, true);
    assert.equal(payload.client.clientEmail, "newclient@example.com");
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("advisor portal can bulk import clients into allowlist", async () => {
  const writes = [];
  const handler = createPortalHandler({
    async getClientProfile(_tableName, _advisorId, clientId) {
      if (clientId === "existing@example.com") {
        return {
          advisorId: "manoj",
          clientId,
          clientEmail: clientId,
          clientDisplayName: "Existing Client",
          accessState: "active",
          policyId: "default",
          createdAt: "2026-02-01T00:00:00.000Z"
        };
      }
      return null;
    },
    async putClientProfile(tableName, item) {
      assert.equal(tableName, "ClientProfilesTable");
      writes.push(item);
    }
  });

  const previousValues = {
    CLIENT_PROFILES_TABLE_NAME: process.env.CLIENT_PROFILES_TABLE_NAME,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    ADVISOR_ID: process.env.ADVISOR_ID,
    CLIENT_POLICY_PRESETS_JSON: process.env.CLIENT_POLICY_PRESETS_JSON
  };

  process.env.CLIENT_PROFILES_TABLE_NAME = "ClientProfilesTable";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.ADVISOR_ID = "manoj";
  process.env.CLIENT_POLICY_PRESETS_JSON = '{"default":["Tue","Wed"],"weekend":["Sat","Sun"],"monday":["Mon"]}';

  try {
    const response = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "POST" }
      },
      rawPath: "/dev/advisor/api/clients/import",
      body: JSON.stringify({
        clientEmails: ["newclient@example.com", "existing@example.com"],
        policyId: "weekend"
      })
    });

    assert.equal(response.statusCode, 200);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].policyId, "weekend");
    assert.equal(writes[1].policyId, "weekend");
    const payload = JSON.parse(response.body);
    assert.equal(payload.importedCount, 2);
    assert.equal(payload.createdCount, 1);
    assert.equal(payload.updatedCount, 1);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("advisor portal settings api returns and updates advisor profile settings", async () => {
  const writes = [];
  let stored = {
    advisorId: "manoj",
    inviteEmail: "manoj@rremerge.com",
    preferredName: "Manoj",
    timezone: "America/Los_Angeles",
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z"
  };
  const handler = createPortalHandler({
    async getAdvisorSettings(tableName, advisorId) {
      assert.equal(tableName, "AdvisorSettingsTable");
      assert.equal(advisorId, "manoj");
      return stored ? { ...stored } : null;
    },
    async putAdvisorSettings(tableName, item) {
      assert.equal(tableName, "AdvisorSettingsTable");
      writes.push(item);
      stored = { ...item };
    }
  });

  const previousValues = {
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    ADVISOR_SETTINGS_TABLE_NAME: process.env.ADVISOR_SETTINGS_TABLE_NAME,
    ADVISOR_ID: process.env.ADVISOR_ID
  };

  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.ADVISOR_SETTINGS_TABLE_NAME = "AdvisorSettingsTable";
  process.env.ADVISOR_ID = "manoj";

  try {
    const getResponse = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/advisor/api/settings"
    });

    assert.equal(getResponse.statusCode, 200);
    const getPayload = JSON.parse(getResponse.body);
    assert.equal(getPayload.settings.inviteEmail, "manoj@rremerge.com");
    assert.equal(getPayload.settings.preferredName, "Manoj");
    assert.equal(getPayload.settings.timezone, "America/Los_Angeles");

    const patchResponse = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "PATCH" }
      },
      rawPath: "/dev/advisor/api/settings",
      body: JSON.stringify({
        inviteEmail: "advisor@newdomain.com",
        preferredName: "Manoj Apte",
        timezone: "America/New_York"
      })
    });

    assert.equal(patchResponse.statusCode, 200);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].inviteEmail, "advisor@newdomain.com");
    assert.equal(writes[0].preferredName, "Manoj Apte");
    assert.equal(writes[0].timezone, "America/New_York");
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("advisor portal settings api validates timezone values", async () => {
  const handler = createPortalHandler({
    async getAdvisorSettings() {
      return {
        advisorId: "manoj",
        inviteEmail: "manoj@rremerge.com",
        preferredName: "Manoj",
        timezone: "America/Los_Angeles"
      };
    },
    async putAdvisorSettings() {
      throw new Error("putAdvisorSettings should not be called for invalid timezone");
    }
  });

  const previousValues = {
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    ADVISOR_SETTINGS_TABLE_NAME: process.env.ADVISOR_SETTINGS_TABLE_NAME,
    ADVISOR_ID: process.env.ADVISOR_ID
  };

  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.ADVISOR_SETTINGS_TABLE_NAME = "AdvisorSettingsTable";
  process.env.ADVISOR_ID = "manoj";

  try {
    const response = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "PATCH" }
      },
      rawPath: "/dev/advisor/api/settings",
      body: JSON.stringify({
        timezone: "Mars/Olympus_Mons"
      })
    });

    assert.equal(response.statusCode, 400);
    const payload = JSON.parse(response.body);
    assert.match(payload.error, /valid IANA timezone/);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("advisor portal settings api rejects agent email already used by another advisor", async () => {
  const handler = createPortalHandler({
    async getAdvisorSettings() {
      return {
        advisorId: "manoj",
        advisorEmail: "manoj@rremerge.com",
        agentEmail: "manoj.agent@agent.letsconnect.ai",
        inviteEmail: "manoj@rremerge.com",
        preferredName: "Manoj",
        timezone: "America/Los_Angeles"
      };
    },
    async getAdvisorSettingsByAgentEmail(_tableName, agentEmail) {
      assert.equal(agentEmail, "shared.agent@agent.letsconnect.ai");
      return {
        advisorId: "lalita",
        agentEmail
      };
    },
    async putAdvisorSettings() {
      throw new Error("putAdvisorSettings should not be called for duplicate agent email");
    }
  });

  const previousValues = {
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    ADVISOR_SETTINGS_TABLE_NAME: process.env.ADVISOR_SETTINGS_TABLE_NAME,
    ADVISOR_ID: process.env.ADVISOR_ID,
    DEFAULT_AGENT_EMAIL_DOMAIN: process.env.DEFAULT_AGENT_EMAIL_DOMAIN
  };

  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.ADVISOR_SETTINGS_TABLE_NAME = "AdvisorSettingsTable";
  process.env.ADVISOR_ID = "manoj";
  process.env.DEFAULT_AGENT_EMAIL_DOMAIN = "agent.letsconnect.ai";

  try {
    const response = await handler({
      requestContext: {
        stage: "dev",
        http: { method: "PATCH" }
      },
      rawPath: "/dev/advisor/api/settings",
      body: JSON.stringify({
        agentEmail: "shared.agent@agent.letsconnect.ai"
      })
    });

    assert.equal(response.statusCode, 400);
    const payload = JSON.parse(response.body);
    assert.match(payload.error, /already in use/i);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
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

test("advisor portal google callback persists calendar connection for advisor from oauth state", async () => {
  let capturedSecretName = null;
  let savedConnection = null;
  const handler = createPortalHandler({
    async getOauthState() {
      return {
        advisorId: "lalita@rremerge.com",
        purpose: "calendar_connection"
      };
    },
    async deleteOauthState() {},
    async getSecretString(secretArn) {
      assert.equal(secretArn, "arn:aws:secretsmanager:us-east-1:111111111111:secret:test");
      return JSON.stringify({
        client_id: "google-client-id",
        client_secret: "google-client-secret"
      });
    },
    async createSecret(secretName, secretValue) {
      capturedSecretName = secretName;
      assert.match(secretValue, /refresh_token/);
      return `arn:aws:secretsmanager:us-east-1:111111111111:secret:${encodeURIComponent(secretName)}`;
    },
    async putConnection(_tableName, item) {
      savedConnection = item;
    },
    fetchImpl: async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return {
          ok: true,
          async json() {
            return {
              access_token: "access-token",
              refresh_token: "refresh-token"
            };
          }
        };
      }

      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return {
          ok: true,
          async json() {
            return {
              email: "lalita@gmail.com"
            };
          }
        };
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }
  });

  const previousValues = {
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    OAUTH_STATE_TABLE_NAME: process.env.OAUTH_STATE_TABLE_NAME,
    CONNECTIONS_TABLE_NAME: process.env.CONNECTIONS_TABLE_NAME,
    GOOGLE_OAUTH_APP_SECRET_ARN: process.env.GOOGLE_OAUTH_APP_SECRET_ARN,
    ADVISOR_ID: process.env.ADVISOR_ID
  };

  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.OAUTH_STATE_TABLE_NAME = "OAuthStateTable";
  process.env.CONNECTIONS_TABLE_NAME = "ConnectionsTable";
  process.env.GOOGLE_OAUTH_APP_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:test";
  process.env.ADVISOR_ID = "manoj";

  try {
    const response = await handler({
      queryStringParameters: {
        code: "oauth-code",
        state: "oauth-state"
      },
      requestContext: {
        domainName: "xytaxmumc3.execute-api.us-east-1.amazonaws.com",
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/advisor/api/connections/google/callback"
    });

    assert.equal(response.statusCode, 302);
    assert.equal(
      response.headers.location,
      "https://xytaxmumc3.execute-api.us-east-1.amazonaws.com/dev/advisor?connected=google"
    );
    assert.ok(capturedSecretName);
    assert.match(capturedSecretName, /\/lalita@rremerge\.com\/connections\//);
    assert.ok(savedConnection);
    assert.equal(savedConnection.advisorId, "lalita@rremerge.com");
    assert.equal(savedConnection.provider, "google");
    assert.equal(savedConnection.accountEmail, "lalita@gmail.com");
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
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

test("availability page renders open slots for valid short token", async () => {
  const tokenId = "abcdefghijklmnop";
  const nowMs = Date.now();
  const handler = createPortalHandler({
    async getAvailabilityLink(tableName, suppliedTokenId) {
      assert.equal(tableName, "AvailabilityLinkTable");
      assert.equal(suppliedTokenId, tokenId);
      return {
        tokenId,
        advisorId: "manoj",
        clientDisplayName: "Tito Needa",
        clientReference: "tito-needa",
        clientTimezone: "America/New_York",
        durationMinutes: 30,
        expiresAtMs: nowMs + 60 * 60 * 1000
      };
    },
    async getPrimaryConnection(tableName, suppliedAdvisorId) {
      assert.equal(tableName, "ConnectionsTable");
      assert.equal(suppliedAdvisorId, "manoj");
      return {
        provider: "mock",
        status: "connected",
        isPrimary: true
      };
    }
  });

  const previousValues = {
    ADVISOR_ID: process.env.ADVISOR_ID,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    AVAILABILITY_LINK_TABLE_NAME: process.env.AVAILABILITY_LINK_TABLE_NAME,
    CONNECTIONS_TABLE_NAME: process.env.CONNECTIONS_TABLE_NAME,
    GOOGLE_OAUTH_APP_SECRET_ARN: process.env.GOOGLE_OAUTH_APP_SECRET_ARN,
    CALENDAR_MODE: process.env.CALENDAR_MODE,
    HOST_TIMEZONE: process.env.HOST_TIMEZONE,
    ADVISING_DAYS: process.env.ADVISING_DAYS,
    SEARCH_DAYS: process.env.SEARCH_DAYS,
    WORKDAY_START_HOUR: process.env.WORKDAY_START_HOUR,
    WORKDAY_END_HOUR: process.env.WORKDAY_END_HOUR,
    DEFAULT_DURATION_MINUTES: process.env.DEFAULT_DURATION_MINUTES,
    MAX_DURATION_MINUTES: process.env.MAX_DURATION_MINUTES,
    AVAILABILITY_COMPARE_UI_ENABLED: process.env.AVAILABILITY_COMPARE_UI_ENABLED,
    AVAILABILITY_VIEW_SLOT_MINUTES: process.env.AVAILABILITY_VIEW_SLOT_MINUTES,
    AVAILABILITY_VIEW_MAX_SLOTS: process.env.AVAILABILITY_VIEW_MAX_SLOTS
  };

  process.env.ADVISOR_ID = "manoj";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.AVAILABILITY_LINK_TABLE_NAME = "AvailabilityLinkTable";
  process.env.CONNECTIONS_TABLE_NAME = "ConnectionsTable";
  delete process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
  process.env.CALENDAR_MODE = "connection";
  process.env.HOST_TIMEZONE = "America/Los_Angeles";
  process.env.ADVISING_DAYS = "Tue,Wed";
  process.env.SEARCH_DAYS = "7";
  process.env.WORKDAY_START_HOUR = "9";
  process.env.WORKDAY_END_HOUR = "11";
  process.env.DEFAULT_DURATION_MINUTES = "30";
  process.env.MAX_DURATION_MINUTES = "120";
  process.env.AVAILABILITY_COMPARE_UI_ENABLED = "true";
  process.env.AVAILABILITY_VIEW_SLOT_MINUTES = "30";
  process.env.AVAILABILITY_VIEW_MAX_SLOTS = "96";

  try {
    const response = await handler({
      queryStringParameters: {
        t: tokenId,
        for: "tito-needa",
        weekOffset: "2"
      },
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/availability"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /text\/html/);
    assert.match(response.body, /Available Times/);
    assert.match(response.body, /id="brand-logo"/);
    assert.match(response.body, /Copyright \(C\) 2026\. RR Emerge LLC/);
    assert.match(response.body, /Please find a slot that works for you and send a calendar invitation to the advisor\./);
    assert.match(response.body, /class="summary" aria-hidden="true">&nbsp;<\/p>/);
    assert.match(response.body, /calendar-carousel/);
    assert.match(response.body, /carousel-viewport/);
    assert.match(response.body, /carousel-nav prev/);
    assert.match(response.body, /carousel-nav next/);
    assert.match(response.body, /calendar-days/);
    assert.match(response.body, /calendar-grid/);
    assert.match(response.body, />Open</);
    assert.match(response.body, />Busy</);
    assert.match(response.body, /Previous Week/);
    assert.match(response.body, /Next Week/);
    assert.match(response.body, /weekOffset=1/);
    assert.match(response.body, /weekOffset=3/);
    assert.equal(response.body.includes('id="local-time-column-label"'), false);
    assert.match(response.body, /Advisor timezone/);
    assert.match(response.body, /Local timezone/);
    assert.match(response.body, /Advisor Calendar/);
    assert.match(response.body, /advisor-time-header/);
    assert.match(response.body, /local-time-header/);
    assert.match(response.body, /<colgroup>/);
    assert.match(response.body, /class="day-card"/);
    assert.match(response.body, /class="col-local"/);
    assert.match(response.body, /class="col-advisor"/);
    assert.match(response.body, /class="slot-row" data-row-index="0"/);
    assert.match(response.body, /function syncSlotRowHeights\(\)/);
    assert.match(response.body, /function initializeDayCarousel\(\)/);
    assert.match(response.body, /function getCardsPerView\(\)/);
    const dayCardMatches = response.body.match(/class="day-card"/g) ?? [];
    assert.equal(dayCardMatches.length, 2);
    assert.match(response.body, /local-slot/);
    assert.match(response.body, /slot-local/);
    assert.match(response.body, /slot-host/);
    assert.match(response.body, /weekday:\s*'short'/);
    assert.ok(
      response.body.indexOf('class="sub-header local-time-header"') <
        response.body.indexOf('class="sub-header advisor-time-header"')
    );
    assert.ok(
      response.body.indexOf('class="slot local-slot') < response.body.indexOf('class="slot advisor-slot')
    );
    assert.match(response.body, /Availability for/);
    assert.match(response.body, /Tito Needa/);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("availability page enforces a one-week window even when SEARCH_DAYS is larger", async () => {
  const tokenId = "weekwindowtoken12";
  const nowMs = Date.now();
  let observedWindow = null;
  const handler = createPortalHandler({
    async getAvailabilityLink() {
      return {
        tokenId,
        advisorId: "manoj",
        clientDisplayName: "Tito Needa",
        durationMinutes: 30,
        expiresAtMs: nowMs + 60 * 60 * 1000
      };
    },
    async getSecretString(secretArn) {
      if (secretArn.endsWith(":secret:google")) {
        return JSON.stringify({
          client_id: "google-client-id",
          client_secret: "google-client-secret",
          refresh_token: "refresh-token",
          calendar_ids: ["primary"]
        });
      }

      throw new Error(`unexpected secret arn: ${secretArn}`);
    },
    async lookupBusyIntervals({ windowStartIso, windowEndIso }) {
      observedWindow = { windowStartIso, windowEndIso };
      return [];
    }
  });

  const previousValues = {
    ADVISOR_ID: process.env.ADVISOR_ID,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    AVAILABILITY_LINK_TABLE_NAME: process.env.AVAILABILITY_LINK_TABLE_NAME,
    GOOGLE_OAUTH_APP_SECRET_ARN: process.env.GOOGLE_OAUTH_APP_SECRET_ARN,
    CALENDAR_MODE: process.env.CALENDAR_MODE,
    GOOGLE_OAUTH_SECRET_ARN: process.env.GOOGLE_OAUTH_SECRET_ARN,
    HOST_TIMEZONE: process.env.HOST_TIMEZONE,
    ADVISING_DAYS: process.env.ADVISING_DAYS,
    SEARCH_DAYS: process.env.SEARCH_DAYS,
    WORKDAY_START_HOUR: process.env.WORKDAY_START_HOUR,
    WORKDAY_END_HOUR: process.env.WORKDAY_END_HOUR,
    AVAILABILITY_VIEW_SLOT_MINUTES: process.env.AVAILABILITY_VIEW_SLOT_MINUTES
  };

  process.env.ADVISOR_ID = "manoj";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.AVAILABILITY_LINK_TABLE_NAME = "AvailabilityLinkTable";
  delete process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
  process.env.CALENDAR_MODE = "google";
  process.env.GOOGLE_OAUTH_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:google";
  process.env.HOST_TIMEZONE = "UTC";
  process.env.ADVISING_DAYS = "Mon,Tue,Wed,Thu,Fri,Sat,Sun";
  process.env.SEARCH_DAYS = "31";
  process.env.WORKDAY_START_HOUR = "9";
  process.env.WORKDAY_END_HOUR = "11";
  process.env.AVAILABILITY_VIEW_SLOT_MINUTES = "30";

  try {
    const response = await handler({
      queryStringParameters: {
        t: tokenId,
        weekOffset: "1"
      },
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/availability"
    });

    assert.equal(response.statusCode, 200);
    assert.ok(observedWindow);
    const startLocal = DateTime.fromISO(observedWindow.windowStartIso, { zone: "utc" }).setZone("UTC");
    const endLocal = DateTime.fromISO(observedWindow.windowEndIso, { zone: "utc" }).setZone("UTC");
    assert.equal(endLocal.diff(startLocal, "days").days, 7);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("availability page includes browser-only client calendar compare controls when Google app client is configured", async () => {
  const tokenId = "comparecalendar123";
  const nowMs = Date.now();
  const handler = createPortalHandler({
    async getAvailabilityLink(tableName, suppliedTokenId) {
      assert.equal(tableName, "AvailabilityLinkTable");
      assert.equal(suppliedTokenId, tokenId);
      return {
        tokenId,
        advisorId: "manoj",
        clientDisplayName: "Tito Needa",
        clientReference: "tito-needa",
        durationMinutes: 30,
        expiresAtMs: nowMs + 60 * 60 * 1000
      };
    },
    async getPrimaryConnection(tableName, suppliedAdvisorId) {
      assert.equal(tableName, "ConnectionsTable");
      assert.equal(suppliedAdvisorId, "manoj");
      return {
        provider: "mock",
        status: "connected",
        isPrimary: true
      };
    },
    async getSecretString(secretArn) {
      assert.equal(secretArn, "arn:aws:secretsmanager:us-east-1:111111111111:secret:portal-app");
      return JSON.stringify({
        client_id: "google-browser-client-id.apps.googleusercontent.com",
        client_secret: "server-only-secret"
      });
    }
  });

  const previousValues = {
    ADVISOR_ID: process.env.ADVISOR_ID,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    AVAILABILITY_LINK_TABLE_NAME: process.env.AVAILABILITY_LINK_TABLE_NAME,
    CONNECTIONS_TABLE_NAME: process.env.CONNECTIONS_TABLE_NAME,
    GOOGLE_OAUTH_APP_SECRET_ARN: process.env.GOOGLE_OAUTH_APP_SECRET_ARN,
    CALENDAR_MODE: process.env.CALENDAR_MODE,
    HOST_TIMEZONE: process.env.HOST_TIMEZONE,
    ADVISING_DAYS: process.env.ADVISING_DAYS,
    SEARCH_DAYS: process.env.SEARCH_DAYS,
    WORKDAY_START_HOUR: process.env.WORKDAY_START_HOUR,
    WORKDAY_END_HOUR: process.env.WORKDAY_END_HOUR,
    DEFAULT_DURATION_MINUTES: process.env.DEFAULT_DURATION_MINUTES,
    MAX_DURATION_MINUTES: process.env.MAX_DURATION_MINUTES,
    AVAILABILITY_COMPARE_UI_ENABLED: process.env.AVAILABILITY_COMPARE_UI_ENABLED,
    AVAILABILITY_VIEW_SLOT_MINUTES: process.env.AVAILABILITY_VIEW_SLOT_MINUTES,
    AVAILABILITY_VIEW_MAX_SLOTS: process.env.AVAILABILITY_VIEW_MAX_SLOTS
  };

  process.env.ADVISOR_ID = "manoj";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.AVAILABILITY_LINK_TABLE_NAME = "AvailabilityLinkTable";
  process.env.CONNECTIONS_TABLE_NAME = "ConnectionsTable";
  process.env.GOOGLE_OAUTH_APP_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:portal-app";
  process.env.CALENDAR_MODE = "connection";
  process.env.HOST_TIMEZONE = "America/Los_Angeles";
  process.env.ADVISING_DAYS = "Tue,Wed";
  process.env.SEARCH_DAYS = "7";
  process.env.WORKDAY_START_HOUR = "9";
  process.env.WORKDAY_END_HOUR = "11";
  process.env.DEFAULT_DURATION_MINUTES = "30";
  process.env.MAX_DURATION_MINUTES = "120";
  process.env.AVAILABILITY_COMPARE_UI_ENABLED = "true";
  process.env.AVAILABILITY_VIEW_SLOT_MINUTES = "30";
  process.env.AVAILABILITY_VIEW_MAX_SLOTS = "96";

  try {
    const response = await handler({
      queryStringParameters: {
        t: tokenId,
        weekOffset: "0"
      },
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/availability"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Optional: compare with your Google Calendar/);
    assert.match(response.body, /id="compare-connect"/);
    assert.match(response.body, /id="compare-clear"/);
    assert.match(response.body, /id="legend-both-open"/);
    assert.match(response.body, /https:\/\/accounts\.google\.com\/gsi\/client/);
    assert.match(response.body, /google-browser-client-id\.apps\.googleusercontent\.com/);
    assert.equal(response.body.includes("server-only-secret"), false);
    assert.match(response.body, /timeMinIso/);
    assert.match(response.body, /timeMaxIso/);
    assert.match(response.body, /function runBrowserCalendarCompare\(\)/);
    assert.match(response.body, /calendar\.readonly/);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("availability page hides browser calendar compare controls by default", async () => {
  const tokenId = "comparedisabled123";
  const nowMs = Date.now();
  const handler = createPortalHandler({
    async getAvailabilityLink() {
      return {
        tokenId,
        advisorId: "manoj",
        clientDisplayName: "Tito Needa",
        durationMinutes: 30,
        expiresAtMs: nowMs + 60 * 60 * 1000
      };
    },
    async getPrimaryConnection() {
      return {
        provider: "mock",
        status: "connected",
        isPrimary: true
      };
    },
    async getSecretString() {
      return JSON.stringify({
        client_id: "google-browser-client-id.apps.googleusercontent.com",
        client_secret: "server-only-secret"
      });
    }
  });

  const previousValues = {
    ADVISOR_ID: process.env.ADVISOR_ID,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    AVAILABILITY_LINK_TABLE_NAME: process.env.AVAILABILITY_LINK_TABLE_NAME,
    CONNECTIONS_TABLE_NAME: process.env.CONNECTIONS_TABLE_NAME,
    GOOGLE_OAUTH_APP_SECRET_ARN: process.env.GOOGLE_OAUTH_APP_SECRET_ARN,
    AVAILABILITY_COMPARE_UI_ENABLED: process.env.AVAILABILITY_COMPARE_UI_ENABLED,
    CALENDAR_MODE: process.env.CALENDAR_MODE,
    HOST_TIMEZONE: process.env.HOST_TIMEZONE,
    ADVISING_DAYS: process.env.ADVISING_DAYS,
    SEARCH_DAYS: process.env.SEARCH_DAYS,
    WORKDAY_START_HOUR: process.env.WORKDAY_START_HOUR,
    WORKDAY_END_HOUR: process.env.WORKDAY_END_HOUR
  };

  process.env.ADVISOR_ID = "manoj";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.AVAILABILITY_LINK_TABLE_NAME = "AvailabilityLinkTable";
  process.env.CONNECTIONS_TABLE_NAME = "ConnectionsTable";
  process.env.GOOGLE_OAUTH_APP_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:portal-app";
  delete process.env.AVAILABILITY_COMPARE_UI_ENABLED;
  process.env.CALENDAR_MODE = "connection";
  process.env.HOST_TIMEZONE = "America/Los_Angeles";
  process.env.ADVISING_DAYS = "Tue,Wed";
  process.env.SEARCH_DAYS = "7";
  process.env.WORKDAY_START_HOUR = "9";
  process.env.WORKDAY_END_HOUR = "11";

  try {
    const response = await handler({
      queryStringParameters: {
        t: tokenId
      },
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/availability"
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes("Optional: compare with your Google Calendar"), false);
    assert.equal(response.body.includes('id="compare-connect"'), false);
    assert.equal(response.body.includes("https://accounts.google.com/gsi/client"), false);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("availability page keeps 30-minute slots while highlighting starts that fit a longer requested duration", async () => {
  const tokenId = "longdurationview15";
  const nowMs = Date.now();
  const handler = createPortalHandler({
    async getAvailabilityLink(tableName, suppliedTokenId) {
      assert.equal(tableName, "AvailabilityLinkTable");
      assert.equal(suppliedTokenId, tokenId);
      return {
        tokenId,
        advisorId: "manoj",
        clientDisplayName: "Tito Needa",
        clientReference: "tito-needa",
        durationMinutes: 120,
        expiresAtMs: nowMs + 60 * 60 * 1000
      };
    },
    async getPrimaryConnection(tableName, suppliedAdvisorId) {
      assert.equal(tableName, "ConnectionsTable");
      assert.equal(suppliedAdvisorId, "manoj");
      return {
        provider: "mock",
        status: "connected",
        isPrimary: true
      };
    }
  });

  const previousValues = {
    ADVISOR_ID: process.env.ADVISOR_ID,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    AVAILABILITY_LINK_TABLE_NAME: process.env.AVAILABILITY_LINK_TABLE_NAME,
    CONNECTIONS_TABLE_NAME: process.env.CONNECTIONS_TABLE_NAME,
    GOOGLE_OAUTH_APP_SECRET_ARN: process.env.GOOGLE_OAUTH_APP_SECRET_ARN,
    CALENDAR_MODE: process.env.CALENDAR_MODE,
    HOST_TIMEZONE: process.env.HOST_TIMEZONE,
    ADVISING_DAYS: process.env.ADVISING_DAYS,
    SEARCH_DAYS: process.env.SEARCH_DAYS,
    WORKDAY_START_HOUR: process.env.WORKDAY_START_HOUR,
    WORKDAY_END_HOUR: process.env.WORKDAY_END_HOUR,
    DEFAULT_DURATION_MINUTES: process.env.DEFAULT_DURATION_MINUTES,
    MAX_DURATION_MINUTES: process.env.MAX_DURATION_MINUTES,
    AVAILABILITY_VIEW_SLOT_MINUTES: process.env.AVAILABILITY_VIEW_SLOT_MINUTES,
    AVAILABILITY_VIEW_MAX_SLOTS: process.env.AVAILABILITY_VIEW_MAX_SLOTS
  };

  process.env.ADVISOR_ID = "manoj";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.AVAILABILITY_LINK_TABLE_NAME = "AvailabilityLinkTable";
  process.env.CONNECTIONS_TABLE_NAME = "ConnectionsTable";
  delete process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
  process.env.CALENDAR_MODE = "connection";
  process.env.HOST_TIMEZONE = "America/Los_Angeles";
  process.env.ADVISING_DAYS = "Tue,Wed";
  process.env.SEARCH_DAYS = "7";
  process.env.WORKDAY_START_HOUR = "9";
  process.env.WORKDAY_END_HOUR = "12";
  process.env.DEFAULT_DURATION_MINUTES = "30";
  process.env.MAX_DURATION_MINUTES = "180";
  process.env.AVAILABILITY_VIEW_SLOT_MINUTES = "30";
  process.env.AVAILABILITY_VIEW_MAX_SLOTS = "200";

  try {
    const response = await handler({
      queryStringParameters: {
        t: tokenId
      },
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/availability"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /9:30 AM/);
    assert.match(response.body, /10:30 AM/);
    assert.match(response.body, /Fits requested 2h meeting/);
    assert.match(response.body, /Highlighted start times can fit your requested meeting length of <code>2h<\/code>/);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("availability page rejects invalid token", async () => {
  const handler = createPortalHandler({
    async getAvailabilityLink() {
      return null;
    }
  });

  const previousAuthMode = process.env.ADVISOR_PORTAL_AUTH_MODE;
  const previousTableName = process.env.AVAILABILITY_LINK_TABLE_NAME;
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.AVAILABILITY_LINK_TABLE_NAME = "AvailabilityLinkTable";

  try {
    const response = await handler({
      queryStringParameters: {
        t: "invalidtoken1234"
      },
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/availability"
    });

    assert.equal(response.statusCode, 403);
    assert.match(response.body, /Invalid or expired availability link/);
  } finally {
    if (previousAuthMode === undefined) {
      delete process.env.ADVISOR_PORTAL_AUTH_MODE;
    } else {
      process.env.ADVISOR_PORTAL_AUTH_MODE = previousAuthMode;
    }

    if (previousTableName === undefined) {
      delete process.env.AVAILABILITY_LINK_TABLE_NAME;
    } else {
      process.env.AVAILABILITY_LINK_TABLE_NAME = previousTableName;
    }
  }
});

test("availability page shows busy blocks without exposing meeting details", async () => {
  const tokenId = "busybusybusybusy";
  const nowMs = Date.now();
  const handler = createPortalHandler({
    async getAvailabilityLink(tableName, suppliedTokenId) {
      assert.equal(tableName, "AvailabilityLinkTable");
      assert.equal(suppliedTokenId, tokenId);
      return {
        tokenId,
        advisorId: "manoj",
        clientDisplayName: "Titoneeda",
        durationMinutes: 30,
        expiresAtMs: nowMs + 60 * 60 * 1000
      };
    },
    async getSecretString(secretArn) {
      if (secretArn.endsWith(":secret:google")) {
        return JSON.stringify({
          client_id: "google-client-id",
          client_secret: "google-client-secret",
          refresh_token: "refresh-token",
          calendar_ids: ["primary"]
        });
      }

      throw new Error(`unexpected secret arn: ${secretArn}`);
    },
    async lookupBusyIntervals({ windowStartIso }) {
      const busyStart = DateTime.fromISO(windowStartIso, { zone: "utc" })
        .setZone("America/Los_Angeles")
        .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
        .toUTC();
      return [
        {
          startIso: busyStart.toISO(),
          endIso: busyStart.plus({ minutes: 30 }).toISO(),
          title: "Quarterly Board Review"
        }
      ];
    }
  });

  const previousValues = {
    ADVISOR_ID: process.env.ADVISOR_ID,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    AVAILABILITY_LINK_TABLE_NAME: process.env.AVAILABILITY_LINK_TABLE_NAME,
    GOOGLE_OAUTH_APP_SECRET_ARN: process.env.GOOGLE_OAUTH_APP_SECRET_ARN,
    CALENDAR_MODE: process.env.CALENDAR_MODE,
    GOOGLE_OAUTH_SECRET_ARN: process.env.GOOGLE_OAUTH_SECRET_ARN,
    HOST_TIMEZONE: process.env.HOST_TIMEZONE,
    ADVISING_DAYS: process.env.ADVISING_DAYS,
    SEARCH_DAYS: process.env.SEARCH_DAYS,
    WORKDAY_START_HOUR: process.env.WORKDAY_START_HOUR,
    WORKDAY_END_HOUR: process.env.WORKDAY_END_HOUR,
    AVAILABILITY_VIEW_SLOT_MINUTES: process.env.AVAILABILITY_VIEW_SLOT_MINUTES
  };

  process.env.ADVISOR_ID = "manoj";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.AVAILABILITY_LINK_TABLE_NAME = "AvailabilityLinkTable";
  delete process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
  process.env.CALENDAR_MODE = "google";
  process.env.GOOGLE_OAUTH_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:google";
  process.env.HOST_TIMEZONE = "America/Los_Angeles";
  process.env.ADVISING_DAYS = "Mon,Tue,Wed,Thu,Fri,Sat,Sun";
  process.env.SEARCH_DAYS = "7";
  process.env.WORKDAY_START_HOUR = "9";
  process.env.WORKDAY_END_HOUR = "11";
  process.env.AVAILABILITY_VIEW_SLOT_MINUTES = "30";

  try {
    const response = await handler({
      queryStringParameters: {
        t: tokenId
      },
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/availability"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /class="slot advisor-slot busy"/);
    assert.match(response.body, /class="slot local-slot busy"/);
    assert.equal(response.body.includes("Quarterly Board Review"), false);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("availability page shows client meeting details with accepted/pending and overlap indicators", async () => {
  const tokenId = "clientmeetingtoken";
  const nowMs = Date.now();
  const handler = createPortalHandler({
    async getAvailabilityLink(tableName, suppliedTokenId) {
      assert.equal(tableName, "AvailabilityLinkTable");
      assert.equal(suppliedTokenId, tokenId);
      return {
        tokenId,
        advisorId: "manoj",
        clientId: "tito@example.com",
        clientEmail: "tito@example.com",
        clientDisplayName: "Tito",
        durationMinutes: 30,
        expiresAtMs: nowMs + 60 * 60 * 1000
      };
    },
    async getSecretString(secretArn) {
      if (secretArn.endsWith(":secret:google")) {
        return JSON.stringify({
          client_id: "google-client-id",
          client_secret: "google-client-secret",
          refresh_token: "refresh-token",
          calendar_ids: ["primary"]
        });
      }

      throw new Error(`unexpected secret arn: ${secretArn}`);
    },
    async lookupBusyIntervals({ windowStartIso }) {
      const slotStart = DateTime.fromISO(windowStartIso, { zone: "utc" })
        .setZone("America/Los_Angeles")
        .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
        .toUTC();
      return [
        {
          startIso: slotStart.toISO(),
          endIso: slotStart.plus({ minutes: 30 }).toISO(),
          calendarId: "primary"
        }
      ];
    },
    async lookupClientMeetings({ clientEmail, windowStartIso }) {
      assert.equal(clientEmail, "tito@example.com");
      const slotStart = DateTime.fromISO(windowStartIso, { zone: "utc" })
        .setZone("America/Los_Angeles")
        .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
        .toUTC();
      return {
        clientMeetings: [
          {
            eventId: "evt-accepted",
            startIso: slotStart.toISO(),
            endIso: slotStart.plus({ minutes: 30 }).toISO(),
            title: "Client Kickoff",
            advisorResponseStatus: "accepted"
          },
          {
            eventId: "evt-pending",
            startIso: slotStart.plus({ minutes: 30 }).toISO(),
            endIso: slotStart.plus({ minutes: 60 }).toISO(),
            title: "Pending Review",
            advisorResponseStatus: "needsAction"
          }
        ],
        nonClientBusyIntervals: [
          {
            startIso: slotStart.plus({ minutes: 15 }).toISO(),
            endIso: slotStart.plus({ minutes: 45 }).toISO()
          }
        ]
      };
    }
  });

  const previousValues = {
    ADVISOR_ID: process.env.ADVISOR_ID,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    AVAILABILITY_LINK_TABLE_NAME: process.env.AVAILABILITY_LINK_TABLE_NAME,
    GOOGLE_OAUTH_APP_SECRET_ARN: process.env.GOOGLE_OAUTH_APP_SECRET_ARN,
    CALENDAR_MODE: process.env.CALENDAR_MODE,
    GOOGLE_OAUTH_SECRET_ARN: process.env.GOOGLE_OAUTH_SECRET_ARN,
    HOST_TIMEZONE: process.env.HOST_TIMEZONE,
    ADVISING_DAYS: process.env.ADVISING_DAYS,
    SEARCH_DAYS: process.env.SEARCH_DAYS,
    WORKDAY_START_HOUR: process.env.WORKDAY_START_HOUR,
    WORKDAY_END_HOUR: process.env.WORKDAY_END_HOUR,
    AVAILABILITY_VIEW_SLOT_MINUTES: process.env.AVAILABILITY_VIEW_SLOT_MINUTES
  };

  process.env.ADVISOR_ID = "manoj";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.AVAILABILITY_LINK_TABLE_NAME = "AvailabilityLinkTable";
  delete process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
  process.env.CALENDAR_MODE = "google";
  process.env.GOOGLE_OAUTH_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:google";
  process.env.HOST_TIMEZONE = "America/Los_Angeles";
  process.env.ADVISING_DAYS = "Mon,Tue,Wed,Thu,Fri,Sat,Sun";
  process.env.SEARCH_DAYS = "7";
  process.env.WORKDAY_START_HOUR = "9";
  process.env.WORKDAY_END_HOUR = "11";
  process.env.AVAILABILITY_VIEW_SLOT_MINUTES = "30";

  try {
    const response = await handler({
      queryStringParameters: {
        t: tokenId
      },
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/availability"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Your meeting \(accepted\)/);
    assert.match(response.body, /Your meeting \(pending\)/);
    assert.match(response.body, /Client Kickoff/);
    assert.match(response.body, /Pending Review/);
    assert.match(response.body, /Potential conflict/);
    assert.match(response.body, /client-accepted/);
    assert.match(response.body, /client-pending/);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("availability page merges long single client meeting into one advisor block", async () => {
  const tokenId = "longmeetingtokenx";
  const nowMs = Date.now();
  const handler = createPortalHandler({
    async getAvailabilityLink(tableName, suppliedTokenId) {
      assert.equal(tableName, "AvailabilityLinkTable");
      assert.equal(suppliedTokenId, tokenId);
      return {
        tokenId,
        advisorId: "manoj",
        clientId: "tito@example.com",
        clientEmail: "tito@example.com",
        clientDisplayName: "Tito",
        durationMinutes: 30,
        expiresAtMs: nowMs + 60 * 60 * 1000
      };
    },
    async getSecretString(secretArn) {
      if (secretArn.endsWith(":secret:google")) {
        return JSON.stringify({
          client_id: "google-client-id",
          client_secret: "google-client-secret",
          refresh_token: "refresh-token",
          calendar_ids: ["primary"]
        });
      }

      throw new Error(`unexpected secret arn: ${secretArn}`);
    },
    async lookupBusyIntervals() {
      return [];
    },
    async lookupClientMeetings({ clientEmail, windowStartIso }) {
      assert.equal(clientEmail, "tito@example.com");
      const slotStart = DateTime.fromISO(windowStartIso, { zone: "utc" })
        .setZone("America/Los_Angeles")
        .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
        .toUTC();
      return {
        clientMeetings: [
          {
            eventId: "evt-long",
            startIso: slotStart.toISO(),
            endIso: slotStart.plus({ minutes: 90 }).toISO(),
            title: "Long Strategy Session",
            advisorResponseStatus: "accepted"
          }
        ],
        nonClientBusyIntervals: []
      };
    }
  });

  const previousValues = {
    ADVISOR_ID: process.env.ADVISOR_ID,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    AVAILABILITY_LINK_TABLE_NAME: process.env.AVAILABILITY_LINK_TABLE_NAME,
    GOOGLE_OAUTH_APP_SECRET_ARN: process.env.GOOGLE_OAUTH_APP_SECRET_ARN,
    CALENDAR_MODE: process.env.CALENDAR_MODE,
    GOOGLE_OAUTH_SECRET_ARN: process.env.GOOGLE_OAUTH_SECRET_ARN,
    HOST_TIMEZONE: process.env.HOST_TIMEZONE,
    ADVISING_DAYS: process.env.ADVISING_DAYS,
    SEARCH_DAYS: process.env.SEARCH_DAYS,
    WORKDAY_START_HOUR: process.env.WORKDAY_START_HOUR,
    WORKDAY_END_HOUR: process.env.WORKDAY_END_HOUR,
    AVAILABILITY_VIEW_SLOT_MINUTES: process.env.AVAILABILITY_VIEW_SLOT_MINUTES
  };

  process.env.ADVISOR_ID = "manoj";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.AVAILABILITY_LINK_TABLE_NAME = "AvailabilityLinkTable";
  delete process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
  process.env.CALENDAR_MODE = "google";
  process.env.GOOGLE_OAUTH_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:google";
  process.env.HOST_TIMEZONE = "America/Los_Angeles";
  process.env.ADVISING_DAYS = "Mon,Tue,Wed,Thu,Fri,Sat,Sun";
  process.env.SEARCH_DAYS = "7";
  process.env.WORKDAY_START_HOUR = "9";
  process.env.WORKDAY_END_HOUR = "11";
  process.env.AVAILABILITY_VIEW_SLOT_MINUTES = "30";

  try {
    const response = await handler({
      queryStringParameters: {
        t: tokenId
      },
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/availability"
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /rowspan="3"/);
    assert.match(response.body, /9:00 AM - 10:30 AM/);
    const titleMatches = response.body.match(/Long Strategy Session/g) ?? [];
    assert.equal(titleMatches.length, 1);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("availability page rejects client profile marked deleted", async () => {
  const tokenId = "rejectclienttoken";
  const nowMs = Date.now();
  const handler = createPortalHandler({
    async getAvailabilityLink() {
      return {
        tokenId,
        advisorId: "manoj",
        clientId: "deleted@example.com",
        clientEmail: "deleted@example.com",
        clientDisplayName: "Deleted Client",
        durationMinutes: 30,
        expiresAtMs: nowMs + 60 * 60 * 1000
      };
    },
    async getClientProfile(tableName, advisorId, clientId) {
      assert.equal(tableName, "ClientProfilesTable");
      assert.equal(advisorId, "manoj");
      assert.equal(clientId, "deleted@example.com");
      return {
        advisorId,
        clientId,
        accessState: "deleted"
      };
    }
  });

  const previousValues = {
    ADVISOR_ID: process.env.ADVISOR_ID,
    ADVISOR_PORTAL_AUTH_MODE: process.env.ADVISOR_PORTAL_AUTH_MODE,
    AVAILABILITY_LINK_TABLE_NAME: process.env.AVAILABILITY_LINK_TABLE_NAME,
    GOOGLE_OAUTH_APP_SECRET_ARN: process.env.GOOGLE_OAUTH_APP_SECRET_ARN,
    CLIENT_PROFILES_TABLE_NAME: process.env.CLIENT_PROFILES_TABLE_NAME
  };
  process.env.ADVISOR_ID = "manoj";
  process.env.ADVISOR_PORTAL_AUTH_MODE = "none";
  process.env.AVAILABILITY_LINK_TABLE_NAME = "AvailabilityLinkTable";
  delete process.env.GOOGLE_OAUTH_APP_SECRET_ARN;
  process.env.CLIENT_PROFILES_TABLE_NAME = "ClientProfilesTable";

  try {
    const response = await handler({
      queryStringParameters: {
        t: tokenId
      },
      requestContext: {
        stage: "dev",
        http: { method: "GET" }
      },
      rawPath: "/dev/availability"
    });

    assert.equal(response.statusCode, 403);
    assert.match(response.body, /no longer has access/i);
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
