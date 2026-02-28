function formatInTimezone(isoUtc, timezone) {
  const date = new Date(isoUtc);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short"
  }).format(date);
}

export function buildHumanReadableOptions({
  suggestions,
  hostTimezone,
  clientTimezone
}) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return "";
  }

  const lines = [];
  for (const [index, suggestion] of suggestions.entries()) {
    const hostLabel = formatInTimezone(suggestion.startIsoUtc, hostTimezone);
    const clientLabel = clientTimezone
      ? formatInTimezone(suggestion.startIsoUtc, clientTimezone)
      : null;

    lines.push(`- ${hostLabel} (${hostTimezone})`);
    if (clientLabel) {
      lines.push(`  Your timezone: ${clientLabel} (${clientTimezone})`);
    }
  }

  return lines.join("\n");
}

export function buildClientResponse({
  suggestions,
  hostTimezone,
  clientTimezone,
  subject
}) {
  const lines = [];
  lines.push("Thanks for reaching out.");

  if (suggestions.length === 0) {
    lines.push("I could not find open slots in the requested window.");
    lines.push("Please share a wider time range and I will send alternatives.");
  } else {
    lines.push("I found these times that could work:");
    lines.push("");
    lines.push(
      buildHumanReadableOptions({
        suggestions,
        hostTimezone,
        clientTimezone
      })
    );
  }

  lines.push("");
  lines.push("Please let me know which time works best for you, or suggest another time.");

  return {
    subject: `Re: ${subject || "Meeting request"}`,
    bodyText: lines.join("\n")
  };
}
