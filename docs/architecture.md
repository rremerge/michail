# Architecture Notes

## Goal
Build a serverless calendar management application that can:
- Parse appointment requests from inbound email.
- Expose calendar APIs for web and automation clients.
- Render a web UI for users to view their calendar.
- Enforce zero retention of email and calendar content after each scheduling task is complete.
- Scale to thousands of clients with response SLA targets (few seconds ideal, 5-minute hard ceiling).
- Provide support/debug workflows so client-reported issues can be traced to root cause.

## Runtime
- Language: TypeScript
- Lambda runtime: Node.js 22.x

## Core Components
- `backend`: Lambda handlers for API and email ingestion.
- `infra`: CDK stack for AWS resources.
- `frontend`: Static single-page app hosted serverlessly.
- `privacy-controls`: Purge workflow and persistence guards that prevent durable storage of email/calendar content.

## Data Model (initial)
- Persistent stores keep only content-free operational metadata (request ids, status, policy outcomes, provider event ids).
- Email payloads and calendar event content are processed transiently and purged at workflow completion.
