import test from "node:test";
import assert from "node:assert/strict";
import {
  parseGoogleOauthSecret,
  exchangeRefreshToken,
  fetchBusyIntervals,
  lookupGoogleBusyIntervals,
  lookupGoogleClientMeetings
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

test("lookupGoogleBusyIntervals splits long windows into multiple freeBusy calls", async () => {
  const freeBusyBodies = [];
  const mockFetch = async (url, options) => {
    if (url.includes("oauth2.googleapis.com")) {
      return {
        ok: true,
        async json() {
          return { access_token: "access" };
        }
      };
    }

    const parsedBody = JSON.parse(options.body);
    freeBusyBodies.push(parsedBody);
    return {
      ok: true,
      async json() {
        return {
          calendars: {
            primary: {
              busy: [
                {
                  start: parsedBody.timeMin,
                  end: parsedBody.timeMax
                }
              ]
            }
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
    windowStartIso: "2026-02-17T00:00:00Z",
    windowEndIso: "2026-06-17T00:00:00Z",
    fetchImpl: mockFetch
  });

  assert.equal(freeBusyBodies.length > 1, true);
  assert.equal(busy.length, freeBusyBodies.length);

  const firstWindowStart = Date.parse(freeBusyBodies[0].timeMin);
  const firstWindowEnd = Date.parse(freeBusyBodies[0].timeMax);
  const firstWindowDays = (firstWindowEnd - firstWindowStart) / (24 * 60 * 60 * 1000);
  assert.equal(firstWindowDays <= 85, true);
});

test("lookupGoogleClientMeetings uses domain matching for non-free email domains", async () => {
  const mockFetch = async (url) => {
    if (url.includes("oauth2.googleapis.com")) {
      return {
        ok: true,
        async json() {
          return { access_token: "access" };
        }
      };
    }

    if (!url.includes("/events")) {
      throw new Error(`unexpected URL: ${url}`);
    }
    const requestUrl = new URL(url);
    const requestedFields = requestUrl.searchParams.get("fields") ?? "";
    assert.equal(requestedFields.includes("organizer(email,responseStatus,self)"), false);
    assert.equal(requestedFields.includes("organizer(email,self)"), true);

    return {
      ok: true,
      async json() {
        return {
          items: [
            {
              id: "evt-1",
              summary: "Client Kickoff",
              start: { dateTime: "2026-03-03T17:00:00Z" },
              end: { dateTime: "2026-03-03T17:30:00Z" },
              attendees: [
                { email: "tito@example.com" },
                { email: "advisor@example.com", self: true, responseStatus: "accepted" }
              ]
            },
            {
              id: "evt-2",
              summary: "Same Domain Different User",
              start: { dateTime: "2026-03-03T18:00:00Z" },
              end: { dateTime: "2026-03-03T18:30:00Z" },
              attendees: [
                { email: "another@example.com" },
                { email: "advisor@example.com", self: true, responseStatus: "needsAction" }
              ]
            },
            {
              id: "evt-3",
              summary: "Internal Meeting",
              start: { dateTime: "2026-03-03T19:00:00Z" },
              end: { dateTime: "2026-03-03T19:30:00Z" },
              attendees: [
                { email: "team@company.com" },
                { email: "advisor@example.com", self: true, responseStatus: "accepted" }
              ]
            },
            {
              id: "evt-4",
              summary: "Client Organizer Domain Match",
              start: { dateTime: "2026-03-03T20:00:00Z" },
              end: { dateTime: "2026-03-03T20:30:00Z" },
              organizer: { email: "owner@example.com" },
              attendees: [{ email: "advisor@example.com", self: true, responseStatus: "accepted" }]
            }
          ]
        };
      }
    };
  };

  const result = await lookupGoogleClientMeetings({
    oauthConfig: {
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      calendarIds: ["primary"]
    },
    windowStartIso: "2026-03-03T00:00:00Z",
    windowEndIso: "2026-03-04T00:00:00Z",
    clientEmail: "tito@example.com",
    advisorEmailHint: "advisor@example.com",
    fetchImpl: mockFetch
  });

  assert.equal(result.clientMeetings.length, 3);
  assert.equal(result.clientMeetings[0].title, "Client Kickoff");
  assert.equal(result.clientMeetings[0].advisorResponseStatus, "accepted");
  assert.equal(result.clientMeetings[1].title, "Same Domain Different User");
  assert.equal(result.clientMeetings[2].title, "Client Organizer Domain Match");
  assert.equal(result.nonClientBusyIntervals.length, 1);
});

test("lookupGoogleClientMeetings uses exact email matching for popular free email domains", async () => {
  const mockFetch = async (url) => {
    if (url.includes("oauth2.googleapis.com")) {
      return {
        ok: true,
        async json() {
          return { access_token: "access" };
        }
      };
    }

    if (!url.includes("/events")) {
      throw new Error(`unexpected URL: ${url}`);
    }

    return {
      ok: true,
      async json() {
        return {
          items: [
            {
              id: "evt-1",
              summary: "Matched Gmail Viewer",
              start: { dateTime: "2026-03-03T17:00:00Z" },
              end: { dateTime: "2026-03-03T17:30:00Z" },
              attendees: [
                { email: "manojapte@gmail.com" },
                { email: "advisor@example.com", self: true, responseStatus: "accepted" }
              ]
            },
            {
              id: "evt-2",
              summary: "Different Gmail User",
              start: { dateTime: "2026-03-03T18:00:00Z" },
              end: { dateTime: "2026-03-03T18:30:00Z" },
              attendees: [
                { email: "other@gmail.com" },
                { email: "advisor@example.com", self: true, responseStatus: "accepted" }
              ]
            },
            {
              id: "evt-3",
              summary: "Internal",
              start: { dateTime: "2026-03-03T19:00:00Z" },
              end: { dateTime: "2026-03-03T19:30:00Z" },
              attendees: [
                { email: "team@company.com" },
                { email: "advisor@example.com", self: true, responseStatus: "accepted" }
              ]
            },
            {
              id: "evt-4",
              summary: "Matched Gmail Organizer",
              start: { dateTime: "2026-03-03T20:00:00Z" },
              end: { dateTime: "2026-03-03T20:30:00Z" },
              organizer: { email: "manojapte@gmail.com" },
              attendees: [{ email: "advisor@example.com", self: true, responseStatus: "accepted" }]
            },
            {
              id: "evt-5",
              summary: "Different Gmail Organizer",
              start: { dateTime: "2026-03-03T21:00:00Z" },
              end: { dateTime: "2026-03-03T21:30:00Z" },
              organizer: { email: "other@gmail.com" },
              attendees: [{ email: "advisor@example.com", self: true, responseStatus: "accepted" }]
            }
          ]
        };
      }
    };
  };

  const result = await lookupGoogleClientMeetings({
    oauthConfig: {
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      calendarIds: ["primary"]
    },
    windowStartIso: "2026-03-03T00:00:00Z",
    windowEndIso: "2026-03-04T00:00:00Z",
    clientEmail: "manojapte@gmail.com",
    advisorEmailHint: "advisor@example.com",
    fetchImpl: mockFetch
  });

  assert.equal(result.clientMeetings.length, 2);
  assert.equal(result.clientMeetings[0].title, "Matched Gmail Viewer");
  assert.equal(result.clientMeetings[1].title, "Matched Gmail Organizer");
  assert.equal(result.nonClientBusyIntervals.length, 3);
});
