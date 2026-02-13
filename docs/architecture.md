# Architecture Notes

## Goal
Build a serverless calendar management application that can:
- Parse appointment requests from inbound email.
- Expose calendar APIs for web and automation clients.
- Render a web UI for users to view their calendar.

## Runtime
- Language: TypeScript
- Lambda runtime: Node.js 22.x

## Core Components
- `backend`: Lambda handlers for API and email ingestion.
- `infra`: CDK stack for AWS resources.
- `frontend`: Static single-page app hosted serverlessly.

## Data Model (initial)
- `Appointments` table
  - PK: `userId`
  - SK: `appointmentAt`
  - Attributes: `id`, `title`, `notes`, `source`, `createdAt`
