const DEFAULT_MODEL = "gpt-5-mini";
const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 4000;

function parseJsonObject(value, contextLabel) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${contextLabel} is not valid JSON: ${error.message}`);
  }
}

function buildPromptPayload({ suggestions, hostTimezone, clientTimezone, originalSubject }) {
  return {
    requestContext: {
      hostTimezone,
      clientTimezone: clientTimezone ?? null,
      originalSubject: originalSubject ?? null
    },
    suggestions: suggestions.map((item, index) => ({
      option: index + 1,
      startIsoUtc: item.startIsoUtc,
      endIsoUtc: item.endIsoUtc,
      hostLabel: item.startIsoHost,
      hostTimezone: item.hostTimezone
    }))
  };
}

function validateDraftResponse(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("LLM response is missing structured JSON object");
  }

  const subject = String(candidate.subject ?? "").trim();
  const bodyText = String(candidate.bodyText ?? "").trim();
  if (!subject || !bodyText) {
    throw new Error("LLM response is missing subject/bodyText");
  }

  return { subject, bodyText };
}

export function parseOpenAiConfigSecret(secretString) {
  const parsed = parseJsonObject(secretString, "OpenAI secret");
  const apiKey = String(parsed.api_key ?? "").trim();
  if (!apiKey) {
    throw new Error("OpenAI secret is missing api_key");
  }

  const model = String(parsed.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const endpoint = String(parsed.endpoint ?? DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
  return {
    apiKey,
    model,
    endpoint
  };
}

export async function draftResponseWithOpenAi({
  openAiConfig,
  suggestions,
  hostTimezone,
  clientTimezone,
  originalSubject,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const fetchFn = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const promptPayload = buildPromptPayload({
    suggestions,
    hostTimezone,
    clientTimezone,
    originalSubject
  });

  const systemPrompt =
    "You draft concise scheduling emails. Never invent meeting times. Use only provided options. " +
    "Return JSON with keys subject and bodyText.";

  const userPrompt =
    "Create a professional response email with numbered options and a clear next action. " +
    "If no suggestions are present, politely ask for a wider window.\n\n" +
    JSON.stringify(promptPayload, null, 2);

  try {
    const response = await fetchFn(openAiConfig.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${openAiConfig.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: openAiConfig.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        response_format: {
          type: "json_object"
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI request failed (${response.status}): ${errorBody}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("OpenAI response did not include message content");
    }

    return validateDraftResponse(parseJsonObject(content, "OpenAI completion"));
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}
