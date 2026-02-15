import test from "node:test";
import assert from "node:assert/strict";
import { createPortalHandler } from "../src/portal-handler.js";

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
