import test from "node:test";
import assert from "node:assert/strict";
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
