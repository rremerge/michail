# Calendar Agent Spike 1 (Email -> Calendar Lookup -> Response)

This repository contains the first executable spike for the calendar agent:
- Ingest a client email-style request.
- Look up availability (mock mode, direct Google free/busy, or advisor-managed connection mode).
- Generate slot suggestions.
- Issue a response (log mode or SES send mode).
- Persist only content-free trace metadata.

## Goals of This Spike
- Prove one end-to-end path quickly.
- Identify authentication and authorization requirements.
- Keep deployment/test simple with AWS SAM (CloudFormation transform).
- Avoid impacting other applications in the AWS account.

## Isolation and Safety Guarantees
- The stack creates isolated resources under its own CloudFormation stack.
- The primary SAM stack does not create account-level SES inbound receipt rule sets.
- Inbound routing is configured in `us-east-1` for `agent@agent.letsconnect.ai`.
- Default mode is `CalendarMode=mock` and `ResponseMode=log` for safe dry-run testing.
- OAuth tokens are stored only in AWS Secrets Manager (KMS encrypted).
- Advisor portal runs as a separate serverless Lambda and stores only connection metadata plus token secrets.
- Advisor portal can require advisor sign-in with Google OAuth before any portal action.

## Project Structure
```text
.
├── app/                      # Lambda app and tests
├── docs/                     # PRD, architecture, transcript
├── events/                   # Sample invocation payloads
└── template.yaml             # SAM/CloudFormation template
```

## Prerequisites
- Node.js 22+
- AWS CLI configured for target account/region
- AWS SAM CLI

## Local Test (before deploy)
```bash
cd app
npm install
npm test
```

## Deploy (Isolated Stack)
```bash
sam build --template-file template.yaml
sam deploy \
  --guided \
  --stack-name calendar-agent-spike-dev \
  --capabilities CAPABILITY_IAM
```

Recommended guided answers for first deploy:
- `CalendarMode`: `mock`
- `ResponseMode`: `log`
- `SenderEmail`: leave blank
- `AdvisorPortalAuthMode`: `google_oauth`

## Minimal Hardening (Advisor Portal Auth)
By default this stack now protects `/advisor` routes with advisor Google login.

1. Set `AdvisorAllowedEmail` parameter (or leave empty to allow any Google account).
2. In Google Cloud OAuth client, add redirect URI:
`https://<api-id>.execute-api.<region>.amazonaws.com/<stage>/advisor/auth/google/callback`
3. Open `AdvisorPortalUrl`; unauthenticated users are redirected to Google login automatically.

## Advisor Portal (Serverless Lambda UI)
After deploy, open `AdvisorPortalUrl` output:

- Add `Mock Calendar (Test)` for immediate end-to-end testing.
- Click `Connect Google (Sign In)` to launch Google login/consent and create a secure refresh-token connection.

## End-to-End Test (Advisor Connection Mode)
Deploy with connection mode:

```bash
sam deploy \
  --stack-name calendar-agent-spike-dev \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides CalendarMode=connection ResponseMode=log
```

Then call `SpikeApiUrl`:

```bash
curl -sS -X POST "<SpikeApiUrl>" \
  -H "content-type: application/json" \
  --data @events/test-email-request.json | jq
```

Expected result:
- HTTP 200 with `requestId`, `responseId`, and `suggestions`.
- A metadata-only trace row is written to DynamoDB.
- The selected advisor connection (mock/google) is used for availability.

## Inbound MIME Parsing (Transient Raw Email)
For real SES inbound emails, this spike now supports transient MIME retrieval:
- SES inbound can store raw MIME to a short-lived S3 bucket in `us-east-1`.
- Spike Lambda reads and parses the MIME body text for scheduling intent extraction.
- Raw MIME object is deleted immediately after processing (best effort).
- Bucket lifecycle policy expires any leftover objects in 1 day.

Trace metadata includes `bodySource` (`inline`, `mail_store`, `mail_store_unavailable`, `none`) without storing email content.

## Supportability Hooks (Feedback + Debug)
Client feedback endpoint (no raw content persistence):

```bash
curl -sS -X POST "https://<api-id>.execute-api.<region>.amazonaws.com/<stage>/spike/feedback" \
  -H "content-type: application/json" \
  --data '{
    "requestId":"<request-id>",
    "responseId":"<response-id>",
    "feedbackType":"incorrect",
    "feedbackReason":"timezone_issue",
    "feedbackSource":"client"
  }' | jq
```

Advisor debug API (Google-auth protected through advisor portal):

```bash
curl -sS "https://<api-id>.execute-api.<region>.amazonaws.com/<stage>/advisor/api/traces/<request-id>" | jq
```

Advisor feedback API:

```bash
curl -sS -X POST "https://<api-id>.execute-api.<region>.amazonaws.com/<stage>/advisor/api/traces/<request-id>/feedback" \
  -H "content-type: application/json" \
  --data '{"responseId":"<response-id>","feedbackType":"odd","feedbackReason":"tone_quality"}' | jq
```

The advisor UI now includes a request-ID debug section to inspect trace metadata and record feedback.

## Repeatable End-to-End Integration Scripts
Send real inbound test mail and verify trace completion:

```bash
cd app
npm run test:e2e:inbound -- \
  --from titoneeda@gmail.com \
  --to agent@agent.letsconnect.ai \
  --trace-table calendar-agent-spike-dev-TraceTable-1DEK59G2YX0UP
```

Verify feedback flow against a known request/response ID:

```bash
cd app
npm run test:e2e:feedback -- \
  --api-base https://xytaxmumc3.execute-api.us-east-1.amazonaws.com/dev \
  --request-id <request-id> \
  --response-id <response-id> \
  --trace-table calendar-agent-spike-dev-TraceTable-1DEK59G2YX0UP
```

## Configure Google OAuth For Portal Flow
1. Set app credentials in `GoogleOAuthAppSecretArn`:

```bash
aws secretsmanager put-secret-value \
  --secret-id <GoogleOAuthAppSecretArn> \
  --secret-string '{"client_id":"<google-client-id>","client_secret":"<google-client-secret>"}'
```

2. In Google Cloud console, set authorized redirect URI:
`https://<api-id>.execute-api.<region>.amazonaws.com/<stage>/advisor/api/connections/google/callback`

3. Open `AdvisorPortalUrl`, click `Connect Google`, complete consent.

## LLM Integration For Email Drafting
The scheduler remains deterministic; LLM is used only for drafting outbound email text.

1. Set provider secret in `LlmProviderSecretArn`:

```bash
aws secretsmanager put-secret-value \
  --secret-id <LlmProviderSecretArn> \
  --secret-string '{"provider":"openai","api_key":"<openai-api-key>","model":"gpt-5-mini","endpoint":"https://api.openai.com/v1/chat/completions"}'
```

2. Redeploy with LLM enabled:

```bash
sam deploy \
  --stack-name calendar-agent-spike-dev \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides CalendarMode=connection ResponseMode=send LlmMode=openai
```

3. Run the end-to-end call and confirm response includes `llmStatus: "ok"` (falls back to template when unavailable).
Default LLM timeout is `15000ms` (`LlmTimeoutMs` parameter).

## Switch to Real Google Calendar Lookup
1. Update the secret value using `GoogleOAuthSecretArn` output:

```bash
aws secretsmanager put-secret-value \
  --secret-id <GoogleOAuthSecretArn> \
  --secret-string '{
    "client_id":"<google-client-id>",
    "client_secret":"<google-client-secret>",
    "refresh_token":"<google-refresh-token>",
    "calendar_ids":["primary"]
  }'
```

2. Redeploy with Google mode:

```bash
sam deploy \
  --stack-name calendar-agent-spike-dev \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides CalendarMode=google ResponseMode=log
```

3. Re-run the curl test.

## Optional: Send Real Response Emails
Set `ResponseMode=send` and provide a verified SES sender identity:

```bash
sam deploy \
  --stack-name calendar-agent-spike-dev \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides CalendarMode=google ResponseMode=send SenderEmail=verified@example.com
```

## Authentication and Authorization Validated by Spike
- Lambda IAM role:
  - `secretsmanager:GetSecretValue` on spike secret.
  - `secretsmanager:GetSecretValue` on advisor connection secrets.
  - `dynamodb:PutItem|UpdateItem` on spike trace table.
  - `dynamodb:Query` on connection table for connection mode.
  - `s3:GetObject|DeleteObject` on transient inbound raw-mail objects (when configured).
  - `ses:SendEmail`/`ses:SendRawEmail` when response mode is send.
- Advisor portal Lambda IAM role:
  - `dynamodb:GetItem|PutItem|DeleteItem|Query` on connection + oauth state tables.
  - `dynamodb:GetItem|UpdateItem` on trace table.
  - `secretsmanager:GetSecretValue` on Google OAuth app secret.
  - `secretsmanager:GetSecretValue` on advisor portal auth secret.
  - `secretsmanager:GetSecretValue` on advisor portal session secret.
  - `secretsmanager:CreateSecret|DeleteSecret` for per-connection token secrets.
- LLM provider secret:
  - Email Lambda reads provider settings/API key from `LlmProviderSecretArn`.
- Google OAuth:
  - Refresh token exchange flow.
  - FreeBusy API access for configured calendars.
- Secure token handling:
  - Tokens only in Secrets Manager.
  - No tokens in logs/traces.

## Data Privacy Guardrails
- No email body/calendar content is persisted in trace tables or logs.
- Raw inbound MIME is transiently stored only long enough to parse and is deleted immediately after use (best effort).
- Trace table stores only metadata (request IDs, status, timing, result counts, provider status).
