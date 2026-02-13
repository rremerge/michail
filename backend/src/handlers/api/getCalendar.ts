import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { listAppointments } from "../../lib/calendarService.js";

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const userId = event.queryStringParameters?.userId;

  if (!userId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing query parameter: userId" })
    };
  }

  const appointments = listAppointments(userId);

  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ appointments })
  };
}
