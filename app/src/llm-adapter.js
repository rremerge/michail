const DEFAULT_MODEL = "gpt-5.2";
const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 4000;
const INTENT_CONFIDENCE_DEFAULT = 0.5;

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
      hostLabel: item.startIsoHost,
      hostTimezone: item.hostTimezone,
      clientTimezone: clientTimezone ?? null
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

function normalizeIntentTimezone(rawTimezone) {
  const candidate = String(rawTimezone ?? "").trim();
  if (!candidate) {
    return null;
  }

  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    formatter.format(new Date("2026-01-01T00:00:00Z"));
    return candidate;
  } catch {
    return null;
  }
}

function normalizeIntentRequestedWindows(rawRequestedWindows) {
  if (!Array.isArray(rawRequestedWindows)) {
    return [];
  }

  const windows = [];
  for (const rawWindow of rawRequestedWindows) {
    const startRaw = String(rawWindow?.startIso ?? "").trim();
    const endRaw = String(rawWindow?.endIso ?? "").trim();
    if (!startRaw || !endRaw) {
      continue;
    }

    const startMs = Date.parse(startRaw);
    const endMs = Date.parse(endRaw);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      continue;
    }

    windows.push({
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString()
    });
  }

  windows.sort((left, right) => left.startIso.localeCompare(right.startIso));
  const deduped = [];
  let previousKey = "";
  for (const item of windows) {
    const key = `${item.startIso}|${item.endIso}`;
    if (key === previousKey) {
      continue;
    }

    deduped.push(item);
    previousKey = key;
  }

  return deduped.slice(0, 10);
}

function clampIntentConfidence(rawConfidence) {
  const parsed = Number(rawConfidence);
  if (Number.isNaN(parsed)) {
    return INTENT_CONFIDENCE_DEFAULT;
  }

  if (parsed < 0) {
    return 0;
  }

  if (parsed > 1) {
    return 1;
  }

  return parsed;
}

function validateIntentExtraction(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("LLM intent extraction response is missing structured JSON object");
  }

  const requestedWindows = normalizeIntentRequestedWindows(candidate.requestedWindows);
  return {
    requestedWindows,
    clientTimezone: normalizeIntentTimezone(candidate.clientTimezone),
    confidence: clampIntentConfidence(candidate.confidence)
  };
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
    "Do not include UTC or ISO timestamps; use clear local-language date/time phrasing. " +
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

export async function extractSchedulingIntentWithOpenAi({
  openAiConfig,
  subject,
  body,
  hostTimezone,
  referenceNowIso,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const fetchFn = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const systemPrompt =
    "You extract scheduling intent from inbound email text. " +
    "Return JSON only. Never include prose or markdown.";

  const userPrompt =
    "Extract client-requested scheduling windows. " +
    "Resolve relative dates from referenceNowIso in hostTimezone unless clientTimezone is explicit. " +
    "If uncertain, leave requestedWindows empty and lower confidence.\n" +
    "Return JSON with keys: requestedWindows (array of {startIso,endIso}), clientTimezone (IANA or null), confidence (0..1).\n\n" +
    JSON.stringify(
      {
        subject: subject ?? "",
        body: body ?? "",
        hostTimezone,
        referenceNowIso
      },
      null,
      2
    );

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
      throw new Error(`OpenAI intent extraction failed (${response.status}): ${errorBody}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("OpenAI response did not include message content for intent extraction");
    }

    return validateIntentExtraction(parseJsonObject(content, "OpenAI intent extraction"));
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`OpenAI intent extraction timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}
