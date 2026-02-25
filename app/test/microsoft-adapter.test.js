import test from "node:test";
import assert from "node:assert/strict";
import {
  exchangeRefreshToken,
  lookupMicrosoftBusyIntervals,
  lookupMicrosoftClientMeetings,
  parseMicrosoftOauthSecret
} from "../src/microsoft-adapter.js";

test("parseMicrosoftOauthSecret validates required fields", () => {
  const parsed = parseMicrosoftOauthSecret(
    JSON.stringify({
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-token",
      tenant_id: "common",
      calendar_ids: ["primary", "team-calendar"]
    })
  );

  assert.equal(parsed.clientId, "client-id");
  assert.equal(parsed.clientSecret, "client-secret");
  assert.equal(parsed.refreshToken, "refresh-token");
  assert.equal(parsed.tenantId, "common");
  assert.deepEqual(parsed.calendarIds, ["primary", "team-calendar"]);
});

test("exchangeRefreshToken posts to microsoft token endpoint and returns access token", async () => {
  const mockFetch = async (url, options) => {
    assert.equal(url, "https://login.microsoftonline.com/common/oauth2/v2.0/token");
    assert.equal(options.method, "POST");
    assert.match(options.body, /grant_type=refresh_token/);
    assert.match(options.body, /Calendars.Read/);
    return {
      ok: true,
      async json() {
        return { access_token: "microsoft-access-token" };
      }
    };
  };

  const token = await exchangeRefreshToken({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    tenantId: "common",
    fetchImpl: mockFetch
  });

  assert.equal(token, "microsoft-access-token");
});

test("lookupMicrosoftBusyIntervals returns busy events from calendarView", async () => {
  const calls = [];
  const mockFetch = async (url) => {
    calls.push(url);
    if (url.includes("/oauth2/v2.0/token")) {
      return {
        ok: true,
        async json() {
          return { access_token: "access-token" };
        }
      };
    }

    return {
      ok: true,
      async json() {
        return {
          value: [
            {
              id: "event-1",
              showAs: "busy",
              isCancelled: false,
              start: {
                dateTime: "2026-03-03T09:00:00",
                timeZone: "America/Los_Angeles"
              },
              end: {
                dateTime: "2026-03-03T09:30:00",
                timeZone: "America/Los_Angeles"
              }
            },
            {
              id: "event-2",
              showAs: "free",
              isCancelled: false,
              start: {
                dateTime: "2026-03-03T10:00:00",
                timeZone: "America/Los_Angeles"
              },
              end: {
                dateTime: "2026-03-03T10:30:00",
                timeZone: "America/Los_Angeles"
              }
            }
          ]
        };
      }
    };
  };

  const busy = await lookupMicrosoftBusyIntervals({
    oauthConfig: {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      tenantId: "common",
      calendarIds: ["primary"]
    },
    windowStartIso: "2026-03-03T00:00:00Z",
    windowEndIso: "2026-03-04T00:00:00Z",
    fetchImpl: mockFetch
  });

  assert.equal(calls.length, 2);
  assert.equal(busy.length, 1);
  assert.equal(busy[0].calendarId, "primary");
  assert.equal(busy[0].startIso, "2026-03-03T17:00:00.000Z");
  assert.equal(busy[0].endIso, "2026-03-03T17:30:00.000Z");
});

test("lookupMicrosoftClientMeetings uses exact-email matching for gmail clients", async () => {
  const mockFetch = async (url) => {
    if (url.includes("/oauth2/v2.0/token")) {
      return {
        ok: true,
        async json() {
          return { access_token: "access-token" };
        }
      };
    }

    return {
      ok: true,
      async json() {
        return {
          value: [
            {
              id: "event-1",
              subject: "Exact Client",
              showAs: "busy",
              isCancelled: false,
              start: { dateTime: "2026-03-03T17:00:00Z", timeZone: "UTC" },
              end: { dateTime: "2026-03-03T17:30:00Z", timeZone: "UTC" },
              responseStatus: { response: "accepted" },
              attendees: [
                { emailAddress: { address: "client@gmail.com" }, status: { response: "accepted" } }
              ],
              organizer: { emailAddress: { address: "advisor@example.com" } }
            },
            {
              id: "event-2",
              subject: "Same Domain Different User",
              showAs: "busy",
              isCancelled: false,
              start: { dateTime: "2026-03-03T18:00:00Z", timeZone: "UTC" },
              end: { dateTime: "2026-03-03T18:30:00Z", timeZone: "UTC" },
              attendees: [
                { emailAddress: { address: "other@gmail.com" }, status: { response: "accepted" } }
              ],
              organizer: { emailAddress: { address: "advisor@example.com" } }
            },
            {
              id: "event-3",
              subject: "Declined Exact Client",
              showAs: "busy",
              isCancelled: false,
              start: { dateTime: "2026-03-03T18:30:00Z", timeZone: "UTC" },
              end: { dateTime: "2026-03-03T19:00:00Z", timeZone: "UTC" },
              responseStatus: { response: "declined" },
              attendees: [
                { emailAddress: { address: "client@gmail.com" }, status: { response: "accepted" } }
              ],
              organizer: { emailAddress: { address: "advisor@example.com" } }
            }
          ]
        };
      }
    };
  };

  const overlay = await lookupMicrosoftClientMeetings({
    oauthConfig: {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      tenantId: "common",
      calendarIds: ["primary"]
    },
    windowStartIso: "2026-03-03T00:00:00Z",
    windowEndIso: "2026-03-04T00:00:00Z",
    clientEmail: "client@gmail.com",
    advisorEmailHint: "advisor@example.com",
    fetchImpl: mockFetch
  });

  assert.equal(overlay.clientMeetings.length, 2);
  assert.equal(overlay.clientMeetings[0].title, "Exact Client");
  assert.equal(overlay.clientMeetings[0].advisorResponseStatus, "accepted");
  assert.equal(overlay.clientMeetings[1].title, "Declined Exact Client");
  assert.equal(overlay.clientMeetings[1].advisorResponseStatus, "declined");
  assert.equal(overlay.nonClientBusyIntervals.length, 1);
});
