export type ParsedEmailRequest = {
  userId: string;
  title: string;
  appointmentAt: string;
  notes?: string;
};

// Expected subject format: "Book | <ISO_DATE> | <TITLE>"
export function parseEmailRequest(subject: string, fromAddress: string): ParsedEmailRequest | null {
  const parts = subject.split("|").map((segment) => segment.trim());
  if (parts.length < 3 || parts[0].toLowerCase() !== "book") {
    return null;
  }

  const appointmentAt = parts[1];
  const title = parts[2];

  if (!appointmentAt || Number.isNaN(Date.parse(appointmentAt)) || !title) {
    return null;
  }

  return {
    userId: fromAddress.toLowerCase(),
    appointmentAt,
    title,
    notes: parts[3]
  };
}
