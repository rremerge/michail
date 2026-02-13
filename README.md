# Calendar Management App (Serverless)

This repository is scaffolded for a calendar management application that runs on AWS Lambda.

## Why TypeScript

TypeScript is the best fit for this project because it provides:
- First-class AWS Lambda support on the Node.js runtime.
- Strong typing across backend, infrastructure, and frontend code.
- Fast local development in VS Code with excellent tooling.
- Shared contracts between API handlers, email processing logic, and web UI.

## High-Level Architecture

- `backend`: Lambda handlers for calendar APIs and email-driven appointment requests.
- `infra`: AWS CDK app for provisioning API Gateway, Lambda functions, and data resources.
- `frontend`: Static web interface for viewing and managing calendar entries.
- `.github`: GitHub workflow for CI.
- `.vscode`: Workspace settings and tasks for local development.

## Suggested AWS Services

- Lambda (Node.js 22)
- API Gateway HTTP API
- DynamoDB (appointments)
- SES inbound email + Lambda trigger
- S3 + CloudFront for static web hosting

## Quick Start

```bash
npm install
npm run typecheck
npm run build
```

## Project Layout

```text
.
├── backend/
├── docs/
├── frontend/
├── infra/
├── .github/
└── .vscode/
```
