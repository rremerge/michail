import { DateTime, Interval } from "luxon";

function normalizeWeekdays(weekdays) {
  const accepted = new Set();
  for (const weekday of weekdays) {
    const normalized = weekday.slice(0, 3).toLowerCase();
    accepted.add(normalized);
  }

  return accepted;
}

function inRequestedWindow(candidateIntervalUtc, requestedWindowsUtc) {
  if (requestedWindowsUtc.length === 0) {
    return true;
  }

  for (const requested of requestedWindowsUtc) {
    if (
      candidateIntervalUtc.start >= requested.start &&
      candidateIntervalUtc.end <= requested.end
    ) {
      return true;
    }
  }

  return false;
}

function overlapsBusy(candidateIntervalUtc, busyIntervalsUtc) {
  return busyIntervalsUtc.some((busy) => busy.overlaps(candidateIntervalUtc));
}

export function generateCandidateSlots({
  busyIntervalsUtc = [],
  requestedWindowsUtc = [],
  hostTimezone,
  advisingWeekdays,
  searchStartUtc,
  searchEndUtc,
  workdayStartHour = 9,
  workdayEndHour = 17,
  durationMinutes = 30,
  maxSuggestions = 3
}) {
  const suggestions = [];
  const acceptedWeekdays = normalizeWeekdays(advisingWeekdays);
  const startUtc = DateTime.fromISO(searchStartUtc, { zone: "utc" });
  const endUtc = DateTime.fromISO(searchEndUtc, { zone: "utc" });

  if (!startUtc.isValid || !endUtc.isValid || endUtc <= startUtc) {
    return suggestions;
  }

  const busy = busyIntervalsUtc
    .map((item) =>
      Interval.fromDateTimes(
        DateTime.fromISO(item.startIso, { zone: "utc" }),
        DateTime.fromISO(item.endIso, { zone: "utc" })
      )
    )
    .filter((interval) => interval.isValid);

  const requestedWindows = requestedWindowsUtc
    .map((item) =>
      Interval.fromDateTimes(
        DateTime.fromISO(item.startIso, { zone: "utc" }),
        DateTime.fromISO(item.endIso, { zone: "utc" })
      )
    )
    .filter((interval) => interval.isValid);

  let localDay = startUtc.setZone(hostTimezone).startOf("day");
  const finalLocalDay = endUtc.setZone(hostTimezone).endOf("day");

  while (localDay <= finalLocalDay && suggestions.length < maxSuggestions) {
    const localWeekday = localDay.toFormat("ccc").toLowerCase();
    if (!acceptedWeekdays.has(localWeekday)) {
      localDay = localDay.plus({ days: 1 });
      continue;
    }

    const dayStart = localDay.set({ hour: workdayStartHour, minute: 0, second: 0, millisecond: 0 });
    const dayEnd = localDay.set({ hour: workdayEndHour, minute: 0, second: 0, millisecond: 0 });
    let slotStart = dayStart;

    while (slotStart.plus({ minutes: durationMinutes }) <= dayEnd && suggestions.length < maxSuggestions) {
      const slotEnd = slotStart.plus({ minutes: durationMinutes });
      const candidateIntervalUtc = Interval.fromDateTimes(slotStart.toUTC(), slotEnd.toUTC());

      if (candidateIntervalUtc.start < startUtc || candidateIntervalUtc.end > endUtc) {
        slotStart = slotStart.plus({ minutes: durationMinutes });
        continue;
      }

      if (!inRequestedWindow(candidateIntervalUtc, requestedWindows)) {
        slotStart = slotStart.plus({ minutes: durationMinutes });
        continue;
      }

      if (overlapsBusy(candidateIntervalUtc, busy)) {
        slotStart = slotStart.plus({ minutes: durationMinutes });
        continue;
      }

      suggestions.push({
        startIsoUtc: candidateIntervalUtc.start.toISO(),
        endIsoUtc: candidateIntervalUtc.end.toISO(),
        startIsoHost: slotStart.toISO(),
        endIsoHost: slotEnd.toISO(),
        hostTimezone
      });

      slotStart = slotStart.plus({ minutes: durationMinutes });
    }

    localDay = localDay.plus({ days: 1 });
  }

  return suggestions;
}
