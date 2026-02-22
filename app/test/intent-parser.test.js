import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { parseSchedulingRequest } from "../src/intent-parser.js";

test("parseSchedulingRequest extracts meeting type, duration, and requested windows", () => {
  const parsed = parseSchedulingRequest({
    fromEmail: "Client@Example.com",
    subject: "In-person 45 minutes",
    body: "Timezone: America/New_York\nI can do 2026-03-03T13:00:00-05:00 to 2026-03-03T15:00:00-05:00"
  });

  assert.equal(parsed.clientEmail, "client@example.com");
  assert.equal(parsed.meetingType, "in_person");
  assert.equal(parsed.durationMinutes, 45);
  assert.equal(parsed.clientTimezone, "America/New_York");
  assert.deepEqual(parsed.requestedWindows, [
    {
      startIso: "2026-03-03T13:00:00-05:00",
      endIso: "2026-03-03T15:00:00-05:00"
    }
  ]);
});

test("parseSchedulingRequest falls back to defaults when fields are absent", () => {
  const parsed = parseSchedulingRequest({
    fromEmail: "a@b.com",
    subject: "Quick chat",
    body: "No explicit windows"
  });

  assert.equal(parsed.durationMinutes, 30);
  assert.equal(parsed.meetingType, "online");
  assert.equal(parsed.requestedWindows.length, 0);
  assert.equal(parsed.clientTimezone, null);
});

test("parseSchedulingRequest extracts weekday time ranges from natural language", () => {
  const parsed = parseSchedulingRequest({
    fromEmail: "a@b.com",
    subject: "Availability",
    body: "Timezone: America/Los_Angeles. I can do Wednesday between 2pm and 4pm.",
    referenceIso: "2026-03-02T10:00:00-08:00",
    fallbackTimezone: "America/Los_Angeles"
  });

  assert.equal(parsed.clientTimezone, "America/Los_Angeles");
  assert.equal(parsed.requestedWindows.length, 1);

  const start = DateTime.fromISO(parsed.requestedWindows[0].startIso);
  const end = DateTime.fromISO(parsed.requestedWindows[0].endIso);
  assert.equal(start.weekday, 3); // Wednesday
  assert.equal(start.hour, 14);
  assert.equal(end.hour, 16);
});

test("parseSchedulingRequest supports daypart windows across multiple weekdays", () => {
  const parsed = parseSchedulingRequest({
    fromEmail: "a@b.com",
    subject: "Scheduling",
    body: "I am available Tuesday and Wednesday afternoon.",
    referenceIso: "2026-03-02T10:00:00-08:00",
    fallbackTimezone: "America/Los_Angeles"
  });

  assert.equal(parsed.requestedWindows.length, 2);

  const starts = parsed.requestedWindows.map((window) => DateTime.fromISO(window.startIso));
  const ends = parsed.requestedWindows.map((window) => DateTime.fromISO(window.endIso));
  assert.deepEqual(
    starts.map((item) => item.weekday),
    [2, 3]
  );
  assert.deepEqual(
    starts.map((item) => item.hour),
    [13, 13]
  );
  assert.deepEqual(
    ends.map((item) => item.hour),
    [17, 17]
  );
});

test("parseSchedulingRequest handles 'next week <weekday>' phrasing", () => {
  const parsed = parseSchedulingRequest({
    fromEmail: "a@b.com",
    subject: "Scheduling",
    body: "Timezone: America/Los_Angeles. I can do next week Wednesday between 2pm and 4pm.",
    referenceIso: "2026-02-17T10:00:00-08:00", // Tuesday
    fallbackTimezone: "America/Los_Angeles"
  });

  assert.equal(parsed.requestedWindows.length, 1);
  const start = DateTime.fromISO(parsed.requestedWindows[0].startIso);
  const end = DateTime.fromISO(parsed.requestedWindows[0].endIso);

  assert.equal(start.toISODate(), "2026-02-25");
  assert.equal(start.hour, 14);
  assert.equal(end.hour, 16);
});

test("parseSchedulingRequest derives broad month window for month-only phrasing", () => {
  const parsed = parseSchedulingRequest({
    fromEmail: "a@b.com",
    subject: "Meeting",
    body: "any time in april works",
    referenceIso: "2026-02-21T10:00:00-08:00",
    fallbackTimezone: "America/Los_Angeles"
  });

  assert.equal(parsed.requestedWindows.length > 0, true);
  const firstStart = DateTime.fromISO(parsed.requestedWindows[0].startIso);
  const lastEnd = DateTime.fromISO(parsed.requestedWindows[parsed.requestedWindows.length - 1].endIso);
  assert.equal(firstStart.toISODate(), "2026-04-01");
  assert.equal(lastEnd.toISODate(), "2026-05-01");
});

test("parseSchedulingRequest derives week-of-month daypart windows", () => {
  const parsed = parseSchedulingRequest({
    fromEmail: "a@b.com",
    subject: "Availability",
    body: "do you have availability in the second week of march in the afternoon",
    referenceIso: "2026-02-21T10:00:00-08:00",
    fallbackTimezone: "America/Los_Angeles"
  });

  assert.equal(parsed.requestedWindows.length > 0, true);
  for (const window of parsed.requestedWindows) {
    const start = DateTime.fromISO(window.startIso);
    const end = DateTime.fromISO(window.endIso);
    assert.equal(start.month, 3);
    assert.equal(start.hour, 13);
    assert.equal(end.hour, 17);
    assert.equal(start.day >= 8 && start.day <= 14, true);
  }
});

test("parseSchedulingRequest derives reversed month-week phrasing", () => {
  const parsed = parseSchedulingRequest({
    fromEmail: "a@b.com",
    subject: "Availability",
    body: "hi do you have any availability in march 2nd week in the afternoon",
    referenceIso: "2026-02-21T10:00:00-08:00",
    fallbackTimezone: "America/Los_Angeles"
  });

  assert.equal(parsed.requestedWindows.length > 0, true);
  for (const window of parsed.requestedWindows) {
    const start = DateTime.fromISO(window.startIso);
    assert.equal(start.month, 3);
    assert.equal(start.day >= 8 && start.day <= 14, true);
    assert.equal(start.hour, 13);
  }
});
