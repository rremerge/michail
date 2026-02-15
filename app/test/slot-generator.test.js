import test from "node:test";
import assert from "node:assert/strict";
import { generateCandidateSlots } from "../src/slot-generator.js";

test("generateCandidateSlots returns first available slot excluding busy intervals", () => {
  const suggestions = generateCandidateSlots({
    hostTimezone: "America/Los_Angeles",
    advisingWeekdays: ["Tue", "Wed"],
    searchStartUtc: "2026-03-03T00:00:00Z",
    searchEndUtc: "2026-03-05T00:00:00Z",
    durationMinutes: 30,
    maxSuggestions: 2,
    busyIntervalsUtc: [
      {
        startIso: "2026-03-03T17:00:00Z",
        endIso: "2026-03-03T17:30:00Z"
      }
    ]
  });

  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0].startIsoUtc, "2026-03-03T17:30:00.000Z");
  assert.equal(suggestions[1].startIsoUtc, "2026-03-03T18:00:00.000Z");
});

test("generateCandidateSlots respects requested windows", () => {
  const suggestions = generateCandidateSlots({
    hostTimezone: "America/Los_Angeles",
    advisingWeekdays: ["Tue"],
    searchStartUtc: "2026-03-03T00:00:00Z",
    searchEndUtc: "2026-03-04T00:00:00Z",
    durationMinutes: 30,
    maxSuggestions: 3,
    requestedWindowsUtc: [
      {
        startIso: "2026-03-03T19:00:00Z",
        endIso: "2026-03-03T20:00:00Z"
      }
    ]
  });

  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0].startIsoUtc, "2026-03-03T19:00:00.000Z");
  assert.equal(suggestions[1].startIsoUtc, "2026-03-03T19:30:00.000Z");
});
