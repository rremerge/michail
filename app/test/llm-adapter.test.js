import test from "node:test";
import assert from "node:assert/strict";
import { draftResponseWithOpenAi, parseOpenAiConfigSecret } from "../src/llm-adapter.js";

test("parseOpenAiConfigSecret requires api_key", () => {
  assert.throws(
    () => parseOpenAiConfigSecret(JSON.stringify({})),
    /missing api_key/
  );
});

test("draftResponseWithOpenAi parses structured chat completion", async () => {
  const openAiConfig = {
    apiKey: "test-api-key",
    model: "gpt-5-mini",
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
