const ISO_TIMESTAMP_PATTERN = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))/g;

function parseDurationMinutes(subject, body, fallback) {
  const merged = `${subject} ${body}`.toLowerCase();
  const match = merged.match(/(\d{1,3})\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\b/);
  if (!match) {
    return fallback;
  }

  const amount = Number.parseInt(match[1], 10);
  if (Number.isNaN(amount) || amount <= 0) {
    return fallback;
  }

  const unit = match[2];
  if (unit.startsWith("hour") || unit === "hr" || unit === "hrs") {
    return amount * 60;
  }

  return amount;
}

function parseMeetingType(subject, body) {
  const merged = `${subject} ${body}`.toLowerCase();
  if (merged.includes("in-person") || merged.includes("in person") || merged.includes("onsite")) {
    return "in_person";
  }

  return "online";
}

function parseRequestedWindows(subject, body) {
  const merged = `${subject}\n${body}`;
  const matches = [...merged.matchAll(ISO_TIMESTAMP_PATTERN)].map((item) => item[1]);
  const requestedWindows = [];

  for (let i = 0; i + 1 < matches.length; i += 2) {
    const startIso = matches[i];
    const endIso = matches[i + 1];
    const startMs = Date.parse(startIso);
    const endMs = Date.parse(endIso);

    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      continue;
    }

    requestedWindows.push({
      startIso,
      endIso
    });
  }

  return requestedWindows;
}

function parseClientTimezone(subject, body) {
  const merged = `${subject}\n${body}`;
  const tzMatch = merged.match(/timezone\s*[:=]\s*([A-Za-z_]+\/[A-Za-z_]+)\b/i);
  return tzMatch?.[1] ?? null;
}

export function parseSchedulingRequest({
  subject = "",
  body = "",
  fromEmail = "",
  defaultDurationMinutes = 30
}) {
  return {
    clientEmail: fromEmail.trim().toLowerCase(),
    meetingType: parseMeetingType(subject, body),
    durationMinutes: parseDurationMinutes(subject, body, defaultDurationMinutes),
    requestedWindows: parseRequestedWindows(subject, body),
    clientTimezone: parseClientTimezone(subject, body)
  };
}
