import type { SESEvent } from "aws-lambda";
import { createAppointment } from "../../lib/calendarService.js";
import { parseEmailRequest } from "../../lib/emailParser.js";

export async function handler(event: SESEvent): Promise<void> {
  for (const record of event.Records) {
    const subject = record.ses.mail.commonHeaders.subject ?? "";
    const fromAddress = record.ses.mail.commonHeaders.from?.[0] ?? "unknown@example.com";

    const parsed = parseEmailRequest(subject, fromAddress);

    if (!parsed) {
      console.log("Skipping email because subject did not match booking format", {
        subject,
        fromAddress
      });
      continue;
    }

    const appointment = createAppointment({
      userId: parsed.userId,
      title: parsed.title,
      appointmentAt: parsed.appointmentAt,
      notes: parsed.notes,
      source: "email"
    });

    console.log("Created appointment from email", { appointmentId: appointment.id, userId: appointment.userId });
  }
}
