import { DateTime } from "luxon";

const ISO_TIMESTAMP_PATTERN = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))/g;
const WEEKDAY_PATTERN =
  /\b(?:(next|this)\s+)?(?:week\s+)?(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)\b/gi;
const RELATIVE_DAY_PATTERN = /\b(today|tomorrow)\b/gi;
const DATE_YMD_PATTERN = /\b(\d{4}-\d{2}-\d{2})\b/g;
const DATE_SLASH_PATTERN = /\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/g;
const DATE_MONTH_PATTERN =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:,\s*(\d{4}))?\b/gi;
const MONTH_ONLY_PATTERN =
  /\b(?:in|during|throughout|sometime\s+in|any\s+time\s+in|anytime\s+in)?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?\b(?!\s+\d{1,2}(?:st|nd|rd|th)?\b)/gi;
const WEEK_OF_MONTH_PATTERN =
  /\b(first|1st|second|2nd|third|3rd|fourth|4th|last)\s+week\s+of\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?\b/gi;
const MONTH_WEEK_PATTERN =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(first|1st|second|2nd|third|3rd|fourth|4th|last)\s+week(?:\s+(\d{4}))?\b/gi;
const TIME_RANGE_PATTERN =
  /\b(?:between|from)?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|to|and)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i;
const DAYPART_PATTERN = /\b(early morning|late morning|morning|afternoon|late afternoon|evening|night|noon|lunch)\b/i;

const WEEKDAY_TO_NUMBER = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7
};

const MONTH_TO_NUMBER = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12
};

const TIMEZONE_ABBREVIATION_TO_IANA = {
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  mst: "America/Denver",
  mdt: "America/Denver",
  cst: "America/Chicago",
  cdt: "America/Chicago",
  est: "America/New_York",
  edt: "America/New_York",
  utc: "UTC",
  gmt: "UTC"
};

const DAYPART_WINDOWS = {
  "early morning": { startMinute: 8 * 60, endMinute: 10 * 60 },
  "late morning": { startMinute: 10 * 60, endMinute: 12 * 60 },
  morning: { startMinute: 9 * 60, endMinute: 12 * 60 },
  noon: { startMinute: 12 * 60, endMinute: 13 * 60 },
  lunch: { startMinute: 12 * 60, endMinute: 13 * 60 },
  afternoon: { startMinute: 13 * 60, endMinute: 17 * 60 },
  "late afternoon": { startMinute: 15 * 60, endMinute: 18 * 60 },
  evening: { startMinute: 17 * 60, endMinute: 20 * 60 },
  night: { startMinute: 19 * 60, endMinute: 22 * 60 }
};

function getMatches(text, regex) {
  return [...String(text ?? "").matchAll(new RegExp(regex.source, regex.flags))];
}

function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeWeekday(rawValue) {
  return String(rawValue ?? "")
    .slice(0, 3)
    .toLowerCase();
}

function canonicalizeMonth(rawValue) {
  const normalized = String(rawValue ?? "").toLowerCase();
  if (normalized.slice(0, 4) === "sept") {
    return "sept";
  }

  return normalized.slice(0, 3);
}

function parseOptionalYear(rawYear, fallbackYear) {
  const trimmed = String(rawYear ?? "").trim();
  if (!trimmed) {
    return {
      year: fallbackYear,
      explicit: false
    };
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isNaN(parsed)) {
    return {
      year: fallbackYear,
      explicit: false
    };
  }

  return {
    year: parsed,
    explicit: true
  };
}

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

function parseIsoRequestedWindows(merged) {
  const matches = getMatches(merged, ISO_TIMESTAMP_PATTERN).map((item) => item[1]);
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

function extractDateDescriptors(clause) {
  const descriptors = [];

  for (const match of getMatches(clause, WEEKDAY_PATTERN)) {
    descriptors.push({
      type: "weekday",
      qualifier: String(match[1] ?? "").toLowerCase(),
      value: canonicalizeWeekday(match[2])
    });
  }

  for (const match of getMatches(clause, RELATIVE_DAY_PATTERN)) {
    descriptors.push({
      type: "relative_day",
      value: String(match[1] ?? "").toLowerCase()
    });
  }

  for (const match of getMatches(clause, DATE_YMD_PATTERN)) {
    descriptors.push({
      type: "date_ymd",
      value: String(match[1] ?? "")
    });
  }

  for (const match of getMatches(clause, DATE_SLASH_PATTERN)) {
    descriptors.push({
      type: "date_slash",
      value: String(match[1] ?? "")
    });
  }

  for (const match of getMatches(clause, DATE_MONTH_PATTERN)) {
    descriptors.push({
      type: "date_month",
      value: normalizeWhitespace(`${match[1]} ${match[2]}${match[3] ? `, ${match[3]}` : ""}`)
    });
  }

  return descriptors;
}

function parseDaypart(clause) {
  const match = clause.match(DAYPART_PATTERN);
  if (!match) {
    return null;
  }

  const normalized = normalizeWhitespace(match[1]).toLowerCase();
  return DAYPART_WINDOWS[normalized] ? normalized : null;
}

function applyMeridiem(hour, meridiem) {
  const normalized = String(meridiem ?? "").toLowerCase();
  if (normalized === "am") {
    return hour === 12 ? 0 : hour;
  }

  if (normalized === "pm") {
    return hour === 12 ? 12 : hour + 12;
  }

  return hour;
}

function parseTimeToken(token, fallbackMeridiem = "") {
  const match = String(token ?? "")
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) {
    return null;
  }

  const hourRaw = Number.parseInt(match[1], 10);
  const minuteRaw = Number.parseInt(match[2] ?? "0", 10);
  if (Number.isNaN(hourRaw) || Number.isNaN(minuteRaw) || minuteRaw < 0 || minuteRaw > 59) {
    return null;
  }

  const explicitMeridiem = String(match[3] ?? "").toLowerCase();
  const resolvedMeridiem = explicitMeridiem || String(fallbackMeridiem ?? "").toLowerCase();
  const hasMeridiem = explicitMeridiem === "am" || explicitMeridiem === "pm";

  if (resolvedMeridiem) {
    if (hourRaw < 1 || hourRaw > 12) {
      return null;
    }

    const hour = applyMeridiem(hourRaw, resolvedMeridiem);
    return {
      hour,
      minute: minuteRaw,
      meridiem: resolvedMeridiem,
      hasMeridiem
    };
  }

  if (hourRaw < 0 || hourRaw > 23) {
    return null;
  }

  return {
    hour: hourRaw,
    minute: minuteRaw,
    meridiem: "",
    hasMeridiem
  };
}

function parseTimeRange(clause, daypart) {
  const match = clause.match(TIME_RANGE_PATTERN);
  if (!match) {
    return null;
  }

  const daypartMeridiem =
    daypart === "morning" || daypart === "early morning" || daypart === "late morning" ? "am" : "pm";
  const endTime = parseTimeToken(match[2], daypart ? daypartMeridiem : "");
  if (!endTime) {
    return null;
  }

  const startTime = parseTimeToken(match[1], endTime.meridiem || (daypart ? daypartMeridiem : ""));
  if (!startTime) {
    return null;
  }

  if (!startTime.hasMeridiem && !endTime.hasMeridiem && !daypart) {
    return null;
  }

  const startMinute = startTime.hour * 60 + startTime.minute;
  let endMinute = endTime.hour * 60 + endTime.minute;

  if (endMinute <= startMinute) {
    if (!endTime.hasMeridiem && endMinute + 12 * 60 > startMinute) {
      endMinute += 12 * 60;
    } else {
      endMinute += 24 * 60;
    }
  }

  if (endMinute <= startMinute) {
    return null;
  }

  return {
    startMinute,
    endMinute
  };
}

function parseReferenceDateTime(referenceIso, timezone) {
  const fromReference = referenceIso
    ? DateTime.fromISO(referenceIso, { zone: timezone })
    : DateTime.now().setZone(timezone);
  if (fromReference.isValid) {
    return fromReference;
  }

  return DateTime.now().setZone(timezone);
}

function resolveWeekdayDate(referenceDate, descriptor) {
  const targetWeekday = WEEKDAY_TO_NUMBER[descriptor.value];
  if (!targetWeekday) {
    return null;
  }

  let daysAhead = (targetWeekday - referenceDate.weekday + 7) % 7;
  if (descriptor.qualifier === "next") {
    daysAhead += daysAhead === 0 ? 7 : 7;
  }

  return referenceDate.startOf("day").plus({ days: daysAhead });
}

function resolveRelativeDate(referenceDate, descriptor) {
  if (descriptor.value === "today") {
    return referenceDate.startOf("day");
  }

  if (descriptor.value === "tomorrow") {
    return referenceDate.startOf("day").plus({ days: 1 });
  }

  return null;
}

function resolveYmdDate(referenceDate, descriptor) {
  const parsed = DateTime.fromISO(descriptor.value, { zone: referenceDate.zoneName });
  return parsed.isValid ? parsed.startOf("day") : null;
}

function resolveSlashDate(referenceDate, descriptor) {
  const match = String(descriptor.value ?? "").match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!match) {
    return null;
  }

  const month = Number.parseInt(match[1], 10);
  const day = Number.parseInt(match[2], 10);
  const rawYear = match[3];
  let year = referenceDate.year;
  if (rawYear) {
    year = Number.parseInt(rawYear, 10);
    if (year < 100) {
      year += 2000;
    }
  }

  let parsed = DateTime.fromObject(
    {
      year,
      month,
      day,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0
    },
    { zone: referenceDate.zoneName }
  );
  if (!parsed.isValid) {
    return null;
  }

  if (!rawYear && parsed < referenceDate.startOf("day")) {
    parsed = parsed.plus({ years: 1 });
  }

  return parsed.startOf("day");
}

function resolveMonthDate(referenceDate, descriptor) {
  const match = String(descriptor.value ?? "")
    .toLowerCase()
    .match(
      /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:,\s*(\d{4}))?$/
    );
  if (!match) {
    return null;
  }

  const monthKey = canonicalizeMonth(match[1]);
  const month = MONTH_TO_NUMBER[monthKey];
  const day = Number.parseInt(match[2], 10);
  const { year } = parseOptionalYear(match[3], referenceDate.year);
  if (!month || Number.isNaN(day) || Number.isNaN(year)) {
    return null;
  }

  let parsed = DateTime.fromObject(
    {
      year,
      month,
      day,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0
    },
    { zone: referenceDate.zoneName }
  );
  if (!parsed.isValid) {
    return null;
  }

  if (!match[3] && parsed < referenceDate.startOf("day")) {
    parsed = parsed.plus({ years: 1 });
  }

  return parsed.startOf("day");
}

function resolveDateDescriptor(referenceDate, descriptor) {
  if (descriptor.type === "weekday") {
    return resolveWeekdayDate(referenceDate, descriptor);
  }

  if (descriptor.type === "relative_day") {
    return resolveRelativeDate(referenceDate, descriptor);
  }

  if (descriptor.type === "date_ymd") {
    return resolveYmdDate(referenceDate, descriptor);
  }

  if (descriptor.type === "date_slash") {
    return resolveSlashDate(referenceDate, descriptor);
  }

  if (descriptor.type === "date_month") {
    return resolveMonthDate(referenceDate, descriptor);
  }

  return null;
}

function parseWeekOrdinal(rawValue) {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  if (normalized === "first" || normalized === "1st") {
    return 1;
  }
  if (normalized === "second" || normalized === "2nd") {
    return 2;
  }
  if (normalized === "third" || normalized === "3rd") {
    return 3;
  }
  if (normalized === "fourth" || normalized === "4th") {
    return 4;
  }
  if (normalized === "last") {
    return "last";
  }

  return null;
}

function resolveMonthSpan(referenceDate, rawMonth, rawYear) {
  const monthKey = canonicalizeMonth(rawMonth);
  const month = MONTH_TO_NUMBER[monthKey];
  const { year, explicit } = parseOptionalYear(rawYear, referenceDate.year);
  if (!month || Number.isNaN(year)) {
    return null;
  }

  let monthStart = DateTime.fromObject(
    {
      year,
      month,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0
    },
    { zone: referenceDate.zoneName }
  );
  if (!monthStart.isValid) {
    return null;
  }

  if (!explicit && monthStart.endOf("month") < referenceDate.startOf("day")) {
    monthStart = monthStart.plus({ years: 1 }).startOf("month");
  }

  const monthEndExclusive = monthStart.plus({ months: 1 }).startOf("month");
  return {
    start: monthStart.startOf("day"),
    end: monthEndExclusive
  };
}

function parseWeekOfMonthSpans(clause, referenceDate) {
  const spans = [];
  for (const match of getMatches(clause, WEEK_OF_MONTH_PATTERN)) {
    const ordinal = parseWeekOrdinal(match[1]);
    if (!ordinal) {
      continue;
    }

    const monthSpan = resolveMonthSpan(referenceDate, match[2], match[3]);
    if (!monthSpan) {
      continue;
    }

    const { start: monthStart, end: monthEnd } = monthSpan;
    let start = monthStart;
    if (ordinal === "last") {
      start = monthEnd.minus({ days: 7 });
      if (start < monthStart) {
        start = monthStart;
      }
    } else {
      start = monthStart.plus({ days: (ordinal - 1) * 7 });
    }

    if (start >= monthEnd) {
      continue;
    }

    let end = start.plus({ days: 7 });
    if (end > monthEnd) {
      end = monthEnd;
    }

    spans.push({
      start: start.startOf("day"),
      end: end.startOf("day")
    });
  }

  for (const match of getMatches(clause, MONTH_WEEK_PATTERN)) {
    const ordinal = parseWeekOrdinal(match[2]);
    if (!ordinal) {
      continue;
    }

    const monthSpan = resolveMonthSpan(referenceDate, match[1], match[3]);
    if (!monthSpan) {
      continue;
    }

    const { start: monthStart, end: monthEnd } = monthSpan;
    let start = monthStart;
    if (ordinal === "last") {
      start = monthEnd.minus({ days: 7 });
      if (start < monthStart) {
        start = monthStart;
      }
    } else {
      start = monthStart.plus({ days: (ordinal - 1) * 7 });
    }

    if (start >= monthEnd) {
      continue;
    }

    let end = start.plus({ days: 7 });
    if (end > monthEnd) {
      end = monthEnd;
    }

    spans.push({
      start: start.startOf("day"),
      end: end.startOf("day")
    });
  }

  return spans;
}

function parseMonthOnlySpans(clause, referenceDate) {
  const spans = [];
  for (const match of getMatches(clause, MONTH_ONLY_PATTERN)) {
    const monthSpan = resolveMonthSpan(referenceDate, match[1], match[2]);
    if (!monthSpan) {
      continue;
    }

    spans.push(monthSpan);
  }

  return spans;
}

function applyMinutesToDate(date, minuteOfDay) {
  const daysOffset = Math.floor(minuteOfDay / (24 * 60));
  const normalizedMinutes = minuteOfDay % (24 * 60);
  const hour = Math.floor(normalizedMinutes / 60);
  const minute = normalizedMinutes % 60;

  return date
    .plus({ days: daysOffset })
    .set({
      hour,
      minute,
      second: 0,
      millisecond: 0
    });
}

function parseNaturalLanguageRequestedWindows({ subject, body, timezone, referenceIso }) {
  const merged = `${subject}\n${body}`;
  const clauses = merged
    .split(/[\n.;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (clauses.length === 0) {
    return [];
  }

  const referenceDate = parseReferenceDateTime(referenceIso, timezone);
  const windows = [];

  for (const clause of clauses) {
    const descriptors = extractDateDescriptors(clause);
    if (descriptors.length === 0) {
      continue;
    }

    const daypart = parseDaypart(clause);
    const parsedRange = parseTimeRange(clause, daypart);
    const range = parsedRange ?? (daypart ? DAYPART_WINDOWS[daypart] : null);
    if (!range) {
      continue;
    }

    for (const descriptor of descriptors) {
      const date = resolveDateDescriptor(referenceDate, descriptor);
      if (!date?.isValid) {
        continue;
      }

      const start = applyMinutesToDate(date, range.startMinute);
      const end = applyMinutesToDate(date, range.endMinute);
      if (!start.isValid || !end.isValid || end <= start) {
        continue;
      }

      windows.push({
        startIso: start.toISO(),
        endIso: end.toISO()
      });
    }
  }

  const deduped = new Map();
  for (const window of windows) {
    const key = `${window.startIso}|${window.endIso}`;
    deduped.set(key, window);
  }

  return [...deduped.values()].sort((left, right) => left.startIso.localeCompare(right.startIso));
}

function parseBroadNaturalLanguageRequestedWindows({ subject, body, timezone, referenceIso }) {
  const merged = `${subject}\n${body}`;
  const clauses = merged
    .split(/[\n.;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (clauses.length === 0) {
    return [];
  }

  const referenceDate = parseReferenceDateTime(referenceIso, timezone);
  const windows = [];

  for (const clause of clauses) {
    const weekOfMonthSpans = parseWeekOfMonthSpans(clause, referenceDate);
    const monthOnlySpans = weekOfMonthSpans.length > 0 ? [] : parseMonthOnlySpans(clause, referenceDate);
    const spans = [...weekOfMonthSpans, ...monthOnlySpans];
    if (spans.length === 0) {
      continue;
    }

    const daypart = parseDaypart(clause);
    const parsedRange = parseTimeRange(clause, daypart);
    const range = parsedRange ?? (daypart ? DAYPART_WINDOWS[daypart] : { startMinute: 0, endMinute: 24 * 60 });

    for (const span of spans) {
      let dayCursor = span.start.startOf("day");
      while (dayCursor < span.end) {
        const start = applyMinutesToDate(dayCursor, range.startMinute);
        const end = applyMinutesToDate(dayCursor, range.endMinute);
        const effectiveStart = start > span.start ? start : span.start;
        const effectiveEnd = end < span.end ? end : span.end;

        if (effectiveStart.isValid && effectiveEnd.isValid && effectiveEnd > effectiveStart) {
          windows.push({
            startIso: effectiveStart.toISO(),
            endIso: effectiveEnd.toISO()
          });
        }

        dayCursor = dayCursor.plus({ days: 1 });
      }
    }
  }

  const deduped = new Map();
  for (const window of windows) {
    const key = `${window.startIso}|${window.endIso}`;
    deduped.set(key, window);
  }

  return [...deduped.values()].sort((left, right) => left.startIso.localeCompare(right.startIso));
}

function parseRequestedWindows({ subject, body, timezone, referenceIso }) {
  const merged = `${subject}\n${body}`;
  const isoWindows = parseIsoRequestedWindows(merged);
  if (isoWindows.length > 0) {
    return isoWindows;
  }

  const naturalLanguageWindows = parseNaturalLanguageRequestedWindows({
    subject,
    body,
    timezone,
    referenceIso
  });
  if (naturalLanguageWindows.length > 0) {
    return naturalLanguageWindows;
  }

  return parseBroadNaturalLanguageRequestedWindows({
    subject,
    body,
    timezone,
    referenceIso
  });
}

function parseClientTimezone(subject, body) {
  const merged = `${subject}\n${body}`;
  const tzMatch = merged.match(/timezone\s*[:=]\s*([A-Za-z_]+\/[A-Za-z_]+)\b/i);
  if (tzMatch?.[1]) {
    return tzMatch[1];
  }

  const abbreviationMatch = merged.match(/\b(PST|PDT|MST|MDT|CST|CDT|EST|EDT|UTC|GMT)\b/i);
  if (abbreviationMatch?.[1]) {
    return TIMEZONE_ABBREVIATION_TO_IANA[String(abbreviationMatch[1]).toLowerCase()] ?? null;
  }

  return null;
}

export function parseSchedulingRequest({
  subject = "",
  body = "",
  fromEmail = "",
  defaultDurationMinutes = 30,
  fallbackTimezone = "UTC",
  referenceIso = ""
}) {
  const clientTimezone = parseClientTimezone(subject, body);
  const parsingTimezone = clientTimezone || fallbackTimezone || "UTC";

  return {
    clientEmail: fromEmail.trim().toLowerCase(),
    meetingType: parseMeetingType(subject, body),
    durationMinutes: parseDurationMinutes(subject, body, defaultDurationMinutes),
    requestedWindows: parseRequestedWindows({
      subject,
      body,
      timezone: parsingTimezone,
      referenceIso
    }),
    clientTimezone
  };
}
