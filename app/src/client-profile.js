const ACCESS_STATE_VALUES = new Set(["active", "blocked", "deleted"]);

const WEEKDAY_LOOKUP = new Map([
  ["mon", "Mon"],
  ["monday", "Mon"],
  ["tue", "Tue"],
  ["tues", "Tue"],
  ["tuesday", "Tue"],
  ["wed", "Wed"],
  ["wednesday", "Wed"],
  ["thu", "Thu"],
  ["thur", "Thu"],
  ["thurs", "Thu"],
  ["thursday", "Thu"],
  ["fri", "Fri"],
  ["friday", "Fri"],
  ["sat", "Sat"],
  ["saturday", "Sat"],
  ["sun", "Sun"],
  ["sunday", "Sun"]
]);

function normalizePolicyKey(rawValue) {
  const normalized = String(rawValue ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return null;
  }

  return /^[a-z0-9_-]{1,32}$/.test(normalized) ? normalized : null;
}

export function normalizeClientId(fromEmail) {
  return String(fromEmail ?? "")
    .trim()
    .toLowerCase();
}

export function normalizeClientAccessState(rawValue, fallback = "active") {
  const normalized = String(rawValue ?? fallback)
    .trim()
    .toLowerCase();
  if (!ACCESS_STATE_VALUES.has(normalized)) {
    return fallback;
  }

  return normalized;
}

export function isClientAccessRestricted(clientProfile) {
  const accessState = normalizeClientAccessState(clientProfile?.accessState, "active");
  return accessState === "blocked" || accessState === "deleted";
}

export function normalizePolicyId(rawValue) {
  return normalizePolicyKey(rawValue);
}

export function parseAdvisingDaysList(rawValue, fallback = ["Tue", "Wed"]) {
  const sourceValues = Array.isArray(rawValue) ? rawValue : String(rawValue ?? "").split(",");
  const days = [];
  const seen = new Set();

  for (const item of sourceValues) {
    const token = String(item ?? "")
      .trim()
      .toLowerCase();
    if (!token) {
      continue;
    }

    const normalized = WEEKDAY_LOOKUP.get(token);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    days.push(normalized);
  }

  if (days.length > 0) {
    return days;
  }

  return Array.from(new Set(fallback.map((item) => WEEKDAY_LOOKUP.get(String(item).toLowerCase()) ?? item))).filter(Boolean);
}

export function parseClientPolicyPresets(rawValue, defaultAdvisingDays) {
  const builtIn = {
    default: parseAdvisingDaysList(defaultAdvisingDays, ["Tue", "Wed"]),
    weekend: ["Sat", "Sun"],
    monday: ["Mon"]
  };

  const candidate = String(rawValue ?? "").trim();
  if (!candidate) {
    return builtIn;
  }

  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return builtIn;
    }

    const output = { ...builtIn };
    for (const [rawKey, rawDays] of Object.entries(parsed)) {
      const key = normalizePolicyKey(rawKey);
      if (!key) {
        continue;
      }

      const days = parseAdvisingDaysList(rawDays, []);
      if (days.length === 0) {
        continue;
      }

      output[key] = days;
    }

    if (!output.default || output.default.length === 0) {
      output.default = builtIn.default;
    }

    return output;
  } catch {
    return builtIn;
  }
}

export function resolveClientAdvisingDays({ clientProfile, defaultAdvisingDays, policyPresets }) {
  const defaultDays = parseAdvisingDaysList(defaultAdvisingDays, ["Tue", "Wed"]);
  const overrideDays = parseAdvisingDaysList(clientProfile?.advisingDaysOverride, []);
  if (overrideDays.length > 0) {
    return overrideDays;
  }

  const effectivePolicyId = normalizePolicyId(clientProfile?.policyId);
  if (effectivePolicyId && policyPresets[effectivePolicyId]?.length > 0) {
    return [...policyPresets[effectivePolicyId]];
  }

  return defaultDays;
}

