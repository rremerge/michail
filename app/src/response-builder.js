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
    lines.push(`I found ${suggestions.length} option(s):`);
    lines.push("");

    for (const [index, suggestion] of suggestions.entries()) {
      const hostLabel = formatInTimezone(suggestion.startIsoUtc, hostTimezone);
      const clientLabel = clientTimezone
        ? formatInTimezone(suggestion.startIsoUtc, clientTimezone)
        : null;

      lines.push(`${index + 1}. ${hostLabel} (${hostTimezone})`);
      if (clientLabel) {
        lines.push(`   Your timezone: ${clientLabel} (${clientTimezone})`);
      }
    }
  }

  lines.push("");
  lines.push("If any option works, reply with the option number.");

  return {
    subject: `Re: ${subject || "Meeting request"}`,
    bodyText: lines.join("\n")
  };
}
