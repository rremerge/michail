import test from "node:test";
import assert from "node:assert/strict";
import {
  draftResponseWithOpenAi,
  extractSchedulingIntentWithOpenAi,
  parseOpenAiConfigSecret
} from "../src/llm-adapter.js";

test("parseOpenAiConfigSecret requires api_key", () => {
  assert.throws(
    () => parseOpenAiConfigSecret(JSON.stringify({})),
    /missing api_key/
  );
});

test("draftResponseWithOpenAi parses structured chat completion", async () => {
  const openAiConfig = {
    apiKey: "test-api-key",
    model: "gpt-5.2",
    endpoint: "https://example.test/v1/chat/completions"
  };

  const result = await draftResponseWithOpenAi({
    openAiConfig,
    suggestions: [
      {
        startIsoUtc: "2026-03-03T17:00:00.000Z",
        endIsoUtc: "2026-03-03T17:30:00.000Z",
        startIsoHost: "2026-03-03T09:00:00.000-08:00",
        hostTimezone: "America/Los_Angeles"
      }
    ],
    hostTimezone: "America/Los_Angeles",
    clientTimezone: "America/New_York",
    originalSubject: "Need 30 min chat",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://example.test/v1/chat/completions");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.authorization, "Bearer test-api-key");
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    subject: "Re: Need 30 min chat",
                    bodyText: "Here are 1 option(s)."
                  })
                }
              }
            ]
          };
        }
      };
    }
  });

  assert.equal(result.subject, "Re: Need 30 min chat");
  assert.equal(result.bodyText, "Here are 1 option(s).");
});

test("extractSchedulingIntentWithOpenAi parses and normalizes requested windows", async () => {
  const openAiConfig = {
    apiKey: "test-api-key",
    model: "gpt-5.2",
    endpoint: "https://example.test/v1/chat/completions"
  };

  const result = await extractSchedulingIntentWithOpenAi({
    openAiConfig,
    subject: "Need appointment",
    body: "Can we do next Wednesday between 2pm and 4pm PT?",
    hostTimezone: "America/Los_Angeles",
    referenceNowIso: "2026-02-17T10:00:00-08:00",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  requestedWindows: [
                    {
                      startIso: "2026-02-25T14:00:00-08:00",
                      endIso: "2026-02-25T16:00:00-08:00"
                    }
                  ],
                  clientTimezone: "America/Los_Angeles",
                  confidence: 0.92
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(result.requestedWindows.length, 1);
  assert.equal(result.requestedWindows[0].startIso, "2026-02-25T22:00:00.000Z");
  assert.equal(result.requestedWindows[0].endIso, "2026-02-26T00:00:00.000Z");
  assert.equal(result.clientTimezone, "America/Los_Angeles");
  assert.equal(result.confidence, 0.92);
});

test("extractSchedulingIntentWithOpenAi drops invalid windows", async () => {
  const openAiConfig = {
    apiKey: "test-api-key",
    model: "gpt-5.2",
    endpoint: "https://example.test/v1/chat/completions"
  };

  const result = await extractSchedulingIntentWithOpenAi({
    openAiConfig,
    subject: "Need appointment",
    body: "Anytime works.",
    hostTimezone: "America/Los_Angeles",
    referenceNowIso: "2026-02-17T10:00:00-08:00",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  requestedWindows: [
                    { startIso: "bad-value", endIso: "2026-02-25T16:00:00-08:00" },
                    { startIso: "2026-02-25T14:00:00-08:00", endIso: "2026-02-25T12:00:00-08:00" }
                  ],
                  clientTimezone: "Not/AZone",
                  confidence: 9
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.deepEqual(result.requestedWindows, []);
  assert.equal(result.clientTimezone, null);
  assert.equal(result.confidence, 1);
});
