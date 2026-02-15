import test from "node:test";
import assert from "node:assert/strict";
import {
  parseGoogleOauthSecret,
  exchangeRefreshToken,
  fetchBusyIntervals,
  lookupGoogleBusyIntervals
} from "../src/google-adapter.js";

test("parseGoogleOauthSecret validates required fields", () => {
  const parsed = parseGoogleOauthSecret(
    JSON.stringify({
      client_id: "abc",
      client_secret: "def",
      refresh_token: "ghi",
      calendar_ids: ["primary", "other@example.com"]
    })
  );

  assert.equal(parsed.clientId, "abc");
  assert.equal(parsed.clientSecret, "def");
  assert.equal(parsed.refreshToken, "ghi");
  assert.deepEqual(parsed.calendarIds, ["primary", "other@example.com"]);
});

test("exchangeRefreshToken sends oauth form and returns access token", async () => {
  const mockFetch = async (url, options) => {
    assert.equal(url, "https://oauth2.googleapis.com/token");
    assert.equal(options.method, "POST");
    assert.match(options.body, /grant_type=refresh_token/);

    return {
      ok: true,
      async json() {
        return { access_token: "test-access" };
      }
    };
  };

  const accessToken = await exchangeRefreshToken({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    fetchImpl: mockFetch
  });

  assert.equal(accessToken, "test-access");
});

test("fetchBusyIntervals maps google freeBusy response", async () => {
  const mockFetch = async () => ({
    ok: true,
    async json() {
      return {
        calendars: {
          primary: {
            busy: [
              {
                start: "2026-03-03T17:00:00Z",
                end: "2026-03-03T17:30:00Z"
              }
            ]
          }
        }
      };
    }
  });

  const busy = await fetchBusyIntervals({
    accessToken: "token",
    calendarIds: ["primary"],
    timeMinIso: "2026-03-03T00:00:00Z",
    timeMaxIso: "2026-03-04T00:00:00Z",
    fetchImpl: mockFetch
  });

  assert.deepEqual(busy, [
    {
      startIso: "2026-03-03T17:00:00Z",
      endIso: "2026-03-03T17:30:00Z",
      calendarId: "primary"
    }
  ]);
});

test("lookupGoogleBusyIntervals exchanges token and fetches busy windows", async () => {
  const calls = [];
  const mockFetch = async (url) => {
    calls.push(url);

    if (url.includes("oauth2.googleapis.com")) {
      return {
        ok: true,
        async json() {
          return { access_token: "access" };
        }
      };
    }

    return {
      ok: true,
      async json() {
        return {
          calendars: {
            primary: { busy: [] }
          }
        };
      }
    };
  };

  const busy = await lookupGoogleBusyIntervals({
    oauthConfig: {
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      calendarIds: ["primary"]
    },
    windowStartIso: "2026-03-03T00:00:00Z",
    windowEndIso: "2026-03-04T00:00:00Z",
    fetchImpl: mockFetch
  });

  assert.equal(calls.length, 2);
  assert.equal(busy.length, 0);
});
