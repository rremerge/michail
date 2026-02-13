import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createAppointment } from "../../lib/calendarService.js";

type RequestBody = {
  userId?: string;
  title?: string;
  appointmentAt?: string;
  notes?: string;
};

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const parsed: RequestBody = event.body ? JSON.parse(event.body) : {};

  if (!parsed.userId || !parsed.title || !parsed.appointmentAt) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "userId, title, and appointmentAt are required" })
    };
  }

  const appointment = createAppointment({
    userId: parsed.userId,
    title: parsed.title,
    appointmentAt: parsed.appointmentAt,
    notes: parsed.notes,
    source: "web"
  });

  return {
    statusCode: 201,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ appointment })
  };
}
