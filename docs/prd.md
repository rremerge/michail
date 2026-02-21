# Product Requirements Document (PRD)

- Product: Intelligent Calendar Booking Agent
- Owner: Manoj
- Status: Draft v1
- Date: 2026-02-13

## 1. Problem Statement
Manoj spends significant manual effort coordinating advisory meetings across multiple calendars and channels. He currently receives requests via email, LinkedIn, and occasionally text, then manually checks multiple Google and Microsoft calendars, finds viable slots, accounts for time zone differences, handles online vs in-person constraints, and protects calendar privacy when sharing availability. This process is time-consuming, error-prone, and hard to scale.

## 2. Goals
1. Automate end-to-end meeting scheduling support for Manoj with an AI agent.
2. Aggregate availability across multiple Google and Microsoft calendar accounts.
3. Suggest high-quality meeting options based on constraints (availability, preferences, time zones, location/travel).
4. Support both assisted scheduling (agent suggests and confirms) and self-serve scheduling (busy/free view).
5. Start with email and web interface while preserving a channel-extensible architecture.
6. Default to GPT-5 for agent intelligence with pluggable LLM provider support for future Claude/Gemini switching.
7. Enforce strict privacy with zero retained email/calendar content after each task is complete.
8. Deliver client-facing responses within a few seconds in normal operation and never exceed 5 minutes.
9. Provide robust debuggability and supportability so response issues can be traced to root cause by agent workflows or by Manoj.
10. Scale reliably to thousands of clients without degrading response quality.
11. Give Manoj advisor-facing client relationship controls (client list, first-contact tracking, usage metrics, delete/block, and day-visibility segmentation).
12. Harden the agent against prompt-injection and adversarial email content so untrusted client text cannot override system behavior.

## 3. Non-Goals (MVP)
1. Full LinkedIn and SMS integration in v1 (capture as future channel integrations).
2. Complex route optimization beyond pragmatic travel-time-aware grouping.
3. Full CRM or billing integration.
4. Native mobile apps.

## 4. Target Users
1. Primary user: Manoj (advisor/host managing advisory conversations).
2. Secondary users: Clients requesting time with Manoj.
3. Organization viewers: External users who may see details only for meetings associated with their organization, while other meetings remain privacy-protected.

## 5. User Journeys
### 5.1 Assisted Scheduling (Email, MVP)
1. Client sends email request with either open-ended request, suggested slots, or time preferences.
2. Agent parses intent, constraints, preferred modality (online/in-person), and candidate windows.
3. Agent checks Manoj availability across all connected calendars and preferred advising days.
4. Agent returns best-fit suggestions in client-friendly format with time zone clarity.
5. On confirmation, agent creates calendar event and sends invite.

### 5.2 Self-Serve Scheduling (Web, MVP)
1. Client opens secure availability page.
2. Client sees only busy/open slots for Manoj's configured advising days.
3. Client cannot view details for private meetings.
4. Client may see meeting details if meeting belongs to their organization and policy permits.
5. Client selects a slot and submits booking request or invite.

### 5.3 In-Person Scheduling
1. Client requests in-person meeting and location.
2. Agent estimates travel buffers to/from venue.
3. Agent avoids conflicting plans and prefers grouping nearby meetings where feasible.

### 5.4 Online Scheduling Across Time Zones
1. Agent identifies Manoj's current timezone and client's timezone.
2. Agent proposes slots with explicit timezone labels and avoids ambiguity.

## 6. Functional Requirements
### FR-1 Channel Intake (MVP: Email)
1. System shall ingest inbound email requests and associate them with conversation threads without persisting email body/attachments after task completion.
2. System shall extract proposed slots, preferred windows, modality, and location when present.

### FR-2 Calendar Aggregation
1. System shall connect to multiple Google and Microsoft calendar accounts.
2. System shall calculate unified busy/free availability across connected accounts without persisting calendar event content after task completion.
3. System shall support configurable "advising days" (default currently Tuesday/Wednesday, user-editable).

### FR-3 Slot Recommendation
1. System shall suggest multiple candidate slots ranked by fit.
2. System shall handle cases where client suggests candidate slots and validate whether they are open.
3. System shall handle cases where client provides preference windows instead of specific slots.

### FR-4 Meeting Modality Constraints
1. System shall support online and in-person meetings.
2. For in-person meetings, system shall include travel-time buffers.
3. System shall attempt practical meeting clustering for nearby locations to reduce driving overhead.

### FR-5 Time Zone Handling
1. System shall detect and normalize time zones for Manoj and clients.
2. System shall present all suggested times with explicit timezone context.
3. System shall support changing Manoj home location/timezone without code changes.

### FR-6 Availability Sharing (Web)
1. System shall provide a web interface showing busy/free blocks for selected advising days.
2. System shall hide sensitive meeting details by default.
3. System shall allow policy-based visibility for meetings belonging to a client's organization.

### FR-7 Conversational Agent Behavior
1. System shall generate context-aware responses for scheduling conversations.
2. System shall request clarifications when constraints are insufficient.
3. System shall maintain only minimal non-content conversation state (for example: thread ids, status flags, timestamps) and purge task content at completion.

### FR-8 Booking Execution
1. System shall create confirmed meetings on the selected calendar account.
2. System shall send confirmation details and invitation artifacts.
3. System shall log booking decisions and rationale for auditability without storing email content or calendar event content.

### FR-9 LLM Provider Abstraction
1. System shall use GPT-5 as default provider for reasoning and response generation.
2. System shall abstract provider integration so Claude/Gemini can be swapped with minimal code changes.

### FR-10 Data Retention and Purge Policy
1. System shall not persist raw email payloads (body, attachments, or full headers) after a scheduling task completes.
2. System shall not persist calendar event content (title, description, attendee list, location notes, body text) after a scheduling task completes.
3. System shall perform explicit purge of transient task data at workflow completion (success, cancellation, or failure).
4. System shall keep only non-content operational metadata required for reliability, audit, and idempotency.

### FR-11 Client Feedback and Correction Loop
1. System shall allow clients to report a response as incorrect or odd from supported channels (MVP: email and web).
2. System shall capture feedback with correlation metadata (request id, response id, timestamp, channel) for investigation.
3. System shall route feedback into an automated investigation workflow that analyzes decision traces and provider interactions.
4. System shall return a correction or escalation response to the client after investigation, within the defined response SLA.

### FR-12 Support and Root-Cause Investigation
1. System shall provide Manoj with an investigation view that shows end-to-end request timeline and decision stages.
2. System shall expose content-free diagnostic artifacts (for example: policy decisions, provider status codes, latency breakdowns, model/prompt version ids, and retry history).
3. System shall support replay/debug of workflow decisions using sanitized metadata and deterministic inputs where possible.
4. System shall allow manual override actions (for example: resend corrected response or trigger re-evaluation) with audit records.

### FR-13 Advisor Client Directory and Engagement Insights
1. System shall maintain a metadata-only client directory for Manoj with one logical client profile per normalized client identity (for example: email-based identity in MVP).
2. System shall track `firstInteractionAt`, `lastInteractionAt`, and interaction counters by channel (`emailAgent`, `availabilityWeb`) for each client.
3. System shall provide advisor UI/API to list and search clients and sort by first contact date, last activity, and usage frequency.
4. System shall update engagement counters from operational events without persisting raw email body or calendar content.

### FR-14 Client Access Governance and Availability Cohorts
1. System shall support per-client access states: `active`, `blocked`, and `deleted`.
2. When a client is marked `deleted`, system shall revoke their availability-link access and deny future scheduling interface use.
3. System shall support default advising-day policy (Tuesday/Wednesday) and per-group policy overrides (for example: weekend-only, Monday-only).
4. System shall allow assigning clients to one or more advisor-defined cohorts/groups where each cohort has allowed day visibility rules.
5. System shall support per-client day-visibility override when needed, with override precedence higher than cohort/default policy.
6. System shall allow the advisor to create, update, and remove custom cohort policies from the advisor portal without code changes or stack redeploy.

### FR-15 Prompt Injection and Untrusted-Input Defense
1. System shall treat all inbound client email content as untrusted input and sanitize/normalize it before any LLM call.
2. System shall isolate untrusted email text from system instructions using strict prompt boundaries and structured input fields.
3. System shall restrict agent actions to an explicit allowlist of scheduling operations; no action may be executed directly from client-authored instructions.
4. System shall apply injection-detection checks (pattern/risk scoring) and route suspicious requests to safe fallback behavior (clarification request or manual-review path).
5. System shall record content-free security diagnostics (for example: injection risk level, guardrail decision, fallback reason) to support investigation without storing raw email content.

### FR-16 Granular Advising Availability Windows (Deferred / Post-MVP)
1. System shall support advisor-defined availability windows with day-of-week and time ranges (for example: Monday 12:00 PM-4:00 PM, Tuesday 9:00 AM-5:00 PM), not only full-day visibility.
2. System shall allow configuring these windows per policy cohort and optionally per individual client override.
3. Scheduling suggestions and web availability rendering shall enforce the effective granular windows for the client.
4. If no granular window is defined for a day, that day shall be treated as unavailable for that policy unless explicitly allowed by fallback configuration.

### FR-17 Client Meeting Visibility Overlay in Availability View
1. System shall identify client-included meetings using inclusion matching rules:
   - Default: match attendee (or organizer) email **domain** to the requesting client's email domain.
   - For common free-email domains (`live.com`, `gmail.com`, `mail.google.com`, `hotmail.com`, `mail.ru`, `yahoo.com`): require **exact email-address** match instead of domain-only match.
2. Availability view shall display client-included meeting detail (for example: event title/summary) instead of generic busy-only rendering for those client-included slots.
3. Availability view shall show advisor RSVP state for client-included meetings:
   - `accepted`: green indicator
   - `not accepted` (for example `needsAction`, `tentative`, or unknown): yellow indicator
4. If a client-included meeting overlaps with additional non-client busy time, the slot shall show both a client-included meeting indicator and an overlapping busy indicator.
5. Non-client meeting details shall remain hidden.

### FR-18 Web Branding and White-Labeling
1. Every rendered web page in this product (advisor portal and client availability view) shall display a legal footer notice: `Copyright (C) 2026. RR Emerge LLC`.
2. Advisor portal and client availability pages shall display a default `letsconnect.ai` logo at the top of the page.
3. Advisor portal shall provide a simple branding control to upload and apply an advisor logo for white-label display.
4. If an advisor-custom logo is active, the page footer shall additionally display `Powered by LetsConnect.ai`.
5. Branding assets and behavior shall be designed so the advisor logo can be replaced without code changes.
6. If no advisor logo is configured, the system shall automatically fall back to the default `letsconnect.ai` logo.

### FR-19 Optional Client Calendar Compare in Browser (Deferred / Experimental)
1. Availability view may offer an optional client action to compare advisor availability against the client's own calendar in the browser.
2. The client must explicitly grant read-only calendar access for a single browser session using provider OAuth consent (for example Google) before any client-calendar fetch occurs.
3. OAuth tokens for this feature shall be handled client-side only, with session-scoped lifetime and automatic discard on logout/session end/page close; backend storage of client OAuth refresh/access tokens for this compare feature is not allowed.
4. Client-calendar busy windows fetched via this mode shall be compared in browser JavaScript with advisor busy/free windows to compute intersection slots open for both parties.
5. Backend services shall not proxy client-calendar read requests for this feature and shall not receive raw client-calendar event payloads from browser compare mode.
6. UI shall clearly indicate that dual-availability results are computed from temporary client consent and may be disabled at any time by the client.
7. If client consent is denied, revoked, expired, or provider API fails, the page shall gracefully fall back to advisor-only availability rendering.

### FR-20 Advisor Profile Defaults and Editable Scheduling Identity
1. System shall initialize advisor profile defaults at first successful advisor-portal Google login:
   - `advisorInviteEmail` default = advisor Google login email.
   - `preferredName` default = advisor Google profile display name (or email-local-part fallback).
   - `timezone` default = `America/Los_Angeles`.
2. Advisor portal shall provide UI/API for advisor to view and update `advisorInviteEmail`, `preferredName`, and `timezone` without redeploying infrastructure.
3. Email-agent booking and response generation shall use advisor profile settings as effective defaults:
   - invite recipient for advisor copy = `advisorInviteEmail`
   - signature/display name = `preferredName`
   - advisor scheduling/rendering timezone = `timezone`
4. If advisor profile settings are missing or partially configured, system shall apply deterministic fallback order:
   - `advisorInviteEmail`: advisor profile setting -> configured environment default -> connection/account fallback
   - `preferredName`: advisor profile setting -> configured environment display name -> advisor id derived label
   - `timezone`: advisor profile setting -> configured environment timezone -> `America/Los_Angeles`
5. Advisor profile updates shall be validated (`inviteEmail` RFC-like email format, `timezone` valid IANA zone, non-empty `preferredName`) before persistence.

### FR-21 Multi-Advisor Tenancy and Agent Alias Routing
1. The deployed agent service shall support concurrent use by multiple advisors from the same cloud deployment.
2. Advisor portal shall allow any authorized advisor to sign in with Google; on first login the system shall create advisor-scoped metadata/profile records without manual provisioning.
3. All mutable and queryable advisor resources (client directory, policy presets, calendar connections, advisor settings, availability links, traces) shall be strictly scoped by `advisorId` so advisor data remains isolated.
4. Inbound scheduling requests shall resolve advisor context using the destination agent email alias (for example `manoj.agent@agent.letsconnect.ai`) when available.
5. Advisor settings shall include a unique `agentEmail` value used for routing inbound email and as default outbound sender identity.
6. Advisor portal shall allow advisor to edit `agentEmail` with validation:
   - valid email format
   - domain must match configured agent email domain
   - value must be unique across all advisors
7. Default `agentEmail` shall be derived at advisor onboarding from advisor identity using `{advisor-local-part}.agent@{configured-agent-domain}` and may be changed later by advisor.
8. If inbound destination alias does not map to a known advisor, system shall blackhole the request (no client response) and record a suppressed trace with admission reason `unknown_agent_alias`; no advisor fallback is allowed.
9. Strict multi-tenant mode shall be enabled in deployed environments; runtime routing must not fall back to single-tenant `ADVISOR_ID` defaults for inbound email or authenticated advisor portal flows.
10. Legacy single-tenant fallback behavior is out of scope and shall not be implemented in production paths.

### FR-22 Client Admission Control and Unknown-Sender Blackhole
1. The agent shall respond only to:
   - the advisor identity for that tenant, or
   - clients that already exist in that advisor's client directory with `active` state.
2. Unknown senders shall receive no response (blackhole behavior), and no scheduling/LLM workflow shall execute for them.
3. System shall support only these client-admission paths:
   - advisor-originated email interactions (participants explicitly listed by advisor in advisor-thread context), or
   - advisor-portal actions (single add/edit or bulk import).
4. There shall be no automatic client creation from unknown inbound email senders.
5. Unknown-sender events shall still produce metadata-only security traces (for example sender hash/domain, reason code, timestamp) without persisting email body content.
6. Advisor portal shall allow advisor to review and manage admitted clients (including block/delete) without exposing unknown-sender email content.

### FR-23 Advisor Cost Visibility and Advisor-Provided LLM Credentials
1. Advisor portal shall display per-advisor LLM usage metrics, including token counts by model/provider and time window (daily/weekly/monthly).
2. System shall provide per-advisor estimated cost views combining:
   - LLM token-based estimates, and
   - key infrastructure usage signals relevant to cost (for example email sends, calendar API calls, function invocations).
3. Advisors shall be able to configure their own LLM provider API key(s) in advisor portal (BYOK), scoped per advisor.
4. Advisor BYOK secrets shall be stored encrypted in AWS Secrets Manager and never rendered in full after save.
5. For request processing, advisor-specific key shall be used when configured; otherwise system shall use tenant default/provider fallback per policy.
6. If advisor key is missing, invalid, or quota-exhausted, system shall apply deterministic fallback behavior (safe template response and advisor notification) without failing silently.
7. Cost and usage reporting shall be tenant-isolated; an advisor must not see another advisor's usage or estimated billing data.

## 7. Non-Functional Requirements
1. Security: Encrypt credentials/tokens in transit and at rest; least-privilege access to calendars and email.
2. Privacy: Default-deny visibility for meeting details except explicit policy exceptions, and zero retention of email/calendar content after task completion.
3. Reliability: Core scheduling workflows available >= 99.9% monthly.
4. Latency and Response SLA:
   - Ideal: client-facing response in a few seconds (target p95 <= 5 seconds for web/API responses, and immediate acknowledgement for email intake).
   - Standard: first meaningful scheduling response target p95 <= 30 seconds.
   - Hard limit: no client request may remain without a response beyond 5 minutes; fallback or escalation response is mandatory before 5 minutes.
5. Scalability: System shall support thousands of clients (minimum 10,000 client identities) and at least 2,000 concurrent active scheduling workflows.
6. Observability and Debuggability: Structured logs, trace IDs, decision-stage telemetry, and failure alerts for intake, parsing, recommendation, and booking stages.
7. Supportability: Provide operational runbooks, investigation tooling, and alerting to achieve mean-time-to-diagnosis (MTTD) <= 10 minutes for high-priority incidents.
8. Extensibility: Channel connectors and LLM providers must be modular.
9. Cost control: Track per-request LLM and infrastructure costs with budget alerts.
10. Advisor client-directory queries must support at least 10,000 client identities with paginated response p95 <= 2 seconds for first-page loads.
11. Access revocation SLA: deleted/blocked clients must lose availability-page access within 5 minutes.
12. Prompt-injection resilience: high-risk injection attempts shall be blocked from changing system/tool behavior and shall trigger fallback handling in <= 5 seconds p95.
13. Branding consistency: all web pages must render required legal footer text and deterministic default branding when no custom advisor branding is configured.
14. Client-browser OAuth safety: optional client-calendar compare shall use least-privilege read-only scopes, session-limited token handling, and no server-side persistence of client OAuth tokens for that feature.
15. Advisor profile consistency: advisor profile defaults and updates shall propagate to email response behavior within one request cycle (no manual restart required).
16. Multi-tenant isolation: no request may read or mutate another advisor's tenant-scoped data; all tenant resolution paths must be deterministic (session advisor identity for portal, destination agent alias for inbound email).
17. Multi-advisor concurrency: architecture shall support at least 1,000 active advisors and 10,000+ total clients while preserving tenant isolation and response SLAs.
18. Unknown-sender abuse control: unknown inbound senders shall be rejected in <= 2 seconds p95 without invoking LLM/calendar providers.
19. Cost observability freshness: advisor cost/usage dashboard data shall be available with <= 15 minute lag for operational decision-making.
20. BYOK security: advisor-provided LLM credentials shall be encrypted at rest, never logged, and access-controlled to least privilege per advisor scope.

## 8. Data and Policy Requirements
1. Persist only non-content metadata required for operations (for example: request ids, workflow status, provider event ids, policy decision outcomes).
2. Do not persist email content or calendar content after task completion.
3. Keep transient scheduling content only for in-flight processing and purge immediately when workflow ends.
4. Support policy rules for organization-level visibility on calendar entries.
5. Maintain content-free audit trail for who/what booked or proposed each slot.
6. Persist content-free diagnostic metadata necessary for troubleshooting and root-cause analysis.
7. Persist client-directory metadata only (for example: normalized client id, display label, first/last interaction timestamps, channel counters, policy assignment, access state).
8. Do not persist client email/calendar content in client-directory records; references must remain metadata-only.
9. On client deletion, revoke active availability tokens/links and keep only minimal suppression metadata required to enforce blocked/deleted state.
10. For security analysis, store only metadata-level injection indicators and guardrail outcomes; never persist raw adversarial prompt content after task completion.
11. Branding configuration shall store only the minimum data needed for rendering (for example: advisor branding preference and logo reference/content), with validation for image type and size.
12. For optional browser-side client-calendar compare, do not persist client calendar OAuth tokens or raw client event content on backend services; only minimal derived metadata (for example: feature-used flag and timestamp) may be recorded if needed.
13. Persist advisor profile metadata only (`advisorId`, `inviteEmail`, `preferredName`, `timezone`, timestamps); do not store additional identity/profile content beyond scheduling needs.
14. Persist advisor routing metadata `agentEmail` as tenant metadata and enforce uniqueness across advisors using indexed lookup; do not store additional email content.
15. Persist client-admission metadata (admission source, advisor approver/import batch id, timestamps, state) to support allowlist enforcement and audits.
16. Unknown-sender events may store only metadata-level suppression artifacts (for example normalized hash, domain, timestamps, reason code); raw unknown email content must not be retained.
17. Persist per-advisor usage/cost aggregates and meter records (token totals, model/provider ids, estimated unit costs, timestamp buckets) without storing prompt or response content.
18. Advisor BYOK LLM credentials shall be stored only in encrypted secret stores, referenced by advisor-scoped metadata pointers; plaintext key material shall not be persisted in application tables or logs.

## 9. Success Metrics
1. Reduce manual scheduling time by >= 70% within first 60 days.
2. >= 80% of scheduling requests handled without manual calendar inspection.
3. <= 2% booking conflict rate.
4. >= 90% response accuracy for timezone rendering in sampled audits.
5. User satisfaction score (Manoj) >= 4/5 for recommendation quality.
6. >= 95% of client-facing responses delivered within 30 seconds.
7. 100% of client requests receive a response or escalation within 5 minutes.
8. >= 95% of feedback reports are triaged with root-cause classification within 1 business day.
9. Mean-time-to-resolution (MTTR) for high-priority response defects <= 4 hours.
10. 100% of deleted/blocked clients are denied availability-link access within 5 minutes of policy update.
11. Manoj can retrieve first page of client directory (default sort) in <= 2 seconds p95.
12. >= 99% of identified prompt-injection attempts are safely contained (no unsafe tool/action execution), with logged guardrail outcome metadata.

## 10. MVP Scope (Release 1)
1. Email intake and response.
2. Unified Google + Microsoft calendar availability.
3. Suggestion engine with client-proposed slot validation.
4. Timezone-aware online scheduling.
5. Basic in-person travel buffer handling.
6. Web busy/free availability view with privacy masking.
7. GPT-5-backed agent with provider abstraction interface.
8. Advisor client directory with first-contact and usage metrics (metadata only).
9. Client cohort/day-visibility policy controls, including delete/block access state.
10. Prompt-injection guardrails for inbound client email content.
11. Client-owned meeting overlay in availability view (detail + accepted/pending + overlap indicators).
12. Branded web experience with default letsconnect.ai logo, legal footer notice, and advisor white-label logo override.
13. Multi-advisor tenancy with destination-alias routing and advisor-configurable `agentEmail`.
14. Unknown-sender admission control with blackhole response policy.

## 11. Out of Scope for MVP
1. LinkedIn integration.
2. SMS/text integration.
3. Advanced multi-stop route optimization.
4. Deep organization directory integrations.
5. Optional client browser-session calendar compare (FR-19).

## 12. Risks and Dependencies
1. External API quotas and rate limits (Google, Microsoft, email provider).
2. Accuracy variance in extracting slot intent from unstructured email.
3. Travel-time estimates may be imprecise without rich location context.
4. LLM provider latency/cost variability.
5. Privacy policy misconfiguration risk in organization-specific visibility.
6. High concurrency spikes could impact response latency unless capacity controls and load shedding are in place.
7. Investigation complexity may increase if telemetry coverage is incomplete.
8. Adversarial prompt-injection attempts may bypass weak sanitization if guardrails are not continuously tested and tuned.

## 13. Acceptance Criteria (MVP)
1. Given connected calendars, when a client requests a meeting by email, then agent responds with at least 3 valid slots (or fewer if constrained) that do not conflict with busy times.
2. Given client-proposed slots, when evaluated, then agent correctly marks each as available/unavailable and suggests nearest alternatives.
3. Given online meeting across different time zones, when suggestions are sent, then each suggestion includes unambiguous local time labeling for both parties.
4. Given in-person request with location, when suggestions are generated, then travel buffers prevent impossible back-to-back bookings.
5. Given web self-serve page access, when user views schedule, then only busy/free blocks are shown by default with no private meeting details.
6. Given org visibility policy, when authorized org user views slots, then only meetings tied to that organization show details.
7. Given provider configuration set to GPT-5, when agent runs, then LLM calls route through provider abstraction and can be switched without business-logic rewrites.
8. Given any completed scheduling task, when data stores and logs are inspected, then no persisted email content or calendar event content exists for that task.
9. Given any client request, when processing exceeds normal latency targets, then the system still provides a client response (answer, fallback, or escalation) within 5 minutes.
10. Given a client reports \"response is incorrect/odd\", when feedback is submitted, then the system links it to request correlation ids and triggers investigation workflow automatically.
11. Given Manoj reviews a reported issue, when opening support tooling, then he can view a complete content-free timeline and identify root cause category without raw email/calendar content.
12. Given Manoj opens advisor client directory, when clients have interacted via email/web, then he can see each client's first interaction date and channel usage counters.
13. Given Manoj marks a client as deleted, when that client opens a previously issued availability link or tries a new scheduling request, then access is denied.
14. Given client cohort policies are configured (for example Tuesday/Wednesday vs weekend vs Monday), when a client views availability, then only days allowed by that client's effective policy are visible.
15. Given inbound email contains instructions attempting to override system behavior, when the request is processed, then the agent treats those instructions as untrusted content, applies guardrails, and returns a safe scheduling response or clarification without executing unsafe actions.
16. Given Manoj creates a new policy cohort in the advisor portal, when he assigns a client to that cohort, then both email suggestions and the web availability view use that cohort's day rules immediately.
17. Given a policy defines granular windows (for example Monday 12:00 PM-4:00 PM), when the client requests or views availability, then only slots within that configured time window are shown and suggested.
18. Given a client is included in meetings on the advisor calendar, when the client opens the availability view, then client-included meetings are shown with detail and acceptance-state color indicators while non-client meetings remain detail-hidden.
19. Given a client-included meeting overlaps other busy time, when rendering that slot, then the slot indicates both client-included meeting presence and overlapping busy state.
20. Given advisor and client web pages are rendered, when page loads, then required legal footer notice is visible, default letsconnect.ai logo is shown unless advisor branding is configured, and `Powered by LetsConnect.ai` appears when advisor custom logo is active.
21. Given a client explicitly grants one-session read-only calendar consent in the availability page, when provider fetch succeeds, then the page shows slots open on both advisor and client calendars without persisting client OAuth tokens or raw client event content on backend services.
22. Given advisor logs into advisor portal with Google for the first time, when profile defaults are initialized, then `advisorInviteEmail` equals login email, `preferredName` is derived from Google profile, and timezone defaults to `America/Los_Angeles`.
23. Given advisor edits invite email, preferred name, or timezone in advisor portal, when update is saved, then subsequent email responses/invite flows use updated values without code changes.
24. Given two advisors are onboarded in the same deployment, when each advisor views/edits clients, policies, and connections, then no advisor can view or mutate the other's data.
25. Given inbound email is sent to `lalita.agent@agent.letsconnect.ai`, when processed, then advisor context resolves to Lalita and does not use Manoj's calendars/settings.
26. Given advisor updates `agentEmail` in advisor portal, when value is valid and unique, then future inbound alias routing and outbound sender identity use the new value.
27. Given advisor attempts to set `agentEmail` already assigned to another advisor, when saving settings, then system rejects update with validation error and no persistence.
28. Given inbound email is from an unknown sender not admitted as advisor/existing client, when processed, then no response is sent and the request is suppressed with metadata-only trace.
29. Given advisor bulk-imports clients in portal, when imported clients send scheduling requests, then agent responds normally while still blackholing non-imported unknown senders.
30. Given advisor configures their own LLM API key, when scheduling requests are processed, then LLM calls for that advisor use their key and usage/cost telemetry appears in advisor-only reporting.

## 14. Future Iterations
1. Add LinkedIn and SMS channel connectors.
2. Add richer routing optimization for in-person clustering.
3. Add configurable meeting templates and intake forms.
4. Add analytics dashboard for conversion and scheduling efficiency.
5. Add granular policy-based advising windows (day + time ranges) in advisor portal policy management.
6. Add optional one-session browser-side client calendar compare (dual-open slot highlighting) with provider OAuth consent.
7. Add richer advisor-profile controls (for example locale, signature templates, per-channel identity overrides) while preserving metadata-only persistence.

## 15. Reference User Story (Verbatim)
User story: 
Manoj reserves a couple of days each week to talk to other technical professionals that seek his advise. The specific two days may change, but right now it is tuesday and wednesday.  He is usually contacted either on Email or Linkedin and rarely on text where a client may request time on his calendar. Manoj then has to look at his calendars on Google and Microsoft (these are multiple accounts). He then has to find possible slots that are not busy and then suggest a few slots.  Sometimes, the client may suggest some slots to begin with or preferences of when they can connect, and manoj has to figure out if there is a open slot that matches those periods. The client may also suggest meeting in person or an online meeting. If it is an in-person meeting, then the location may add time constraints due to travel to and from the venue. Manoj then has to figure out if he can bunch up a few meetings in near by locations together to optimize the time spent driving. For online meetings, the client may be in a different time zone so it is important to ensure the timezone for where manoj resides and where the client resides is taken into account. Right now, manoj is in California but that can change. Sometimes the clients prefer to just look for any empty slots themselves on manoj's calendar and then send an invitation themselves. In that case, manoj has to share a calendar view that shows busy and open time slots for the 2 days that he prefers to work but without any details of what meetings are in the busy slots for privacy. The client maybe able to see any meetings that belong to their organization. 

Manoj would like this workflow to be handled by an intelligent AI agent that looks up all his calendars and suggests possible times that they might be able to book. The agent should interact and converse on whatever medium they contact him on. To start with just an email  and we interface would be sufficient. He currently likes the GPT-5 engine for the LLM for the agent, but he may want to switch to claud or gemini in future.

The Advisor would like to have the ability to get a list of all the clients they have interfaced with. They would like to track when they initiated their first connection, and how often the client uses the calendar interface (either via email agent or the website) to book meeting times. The advisor would also like to ensure that they can delete a client so they can no longer so the calendar. While by default the advisor wants to provide tuesday and wednesday calendars to most clients, they may give a different set of days to some other clients. For instance, there maybe groups of clients that only see tuesday and wednesday, another group that see only the weekend, and another group that may see only monday.

The Advisor is worried that LLMs may get tricked by a malicious client with a specially crafted email that makes it interpret the email as instructions. The agent needs to take appropriate precautions and make sure that any email content from a client is first sanitized to ensure there are no prompt injection like attacks.

The Advisor would like to create and manage multiple access policy groups directly in the advisor portal (not only system defaults), then assign those policies to clients so each client or client group can see the intended advising days.

The Advisor would also like future support for more granular availability configuration than only days of the week, such as defining Monday 12:00 PM-4:00 PM and Tuesday 9:00 AM-5:00 PM as bookable windows.

When a client is included in a meeting on the advisor calendar, the availability view should show meeting detail for that client-included meeting instead of only showing the slot as busy. If the advisor has accepted the meeting, show it in green; if not accepted, show it in yellow. If the client-included meeting overlaps with other busy events, the slot should clearly indicate both the busy overlap and the client-included scheduled meeting. For display classification, inclusion defaults to attendee/organizer domain matching, except for common free-email domains (`live.com`, `gmail.com`, `mail.google.com`, `hotmail.com`, `mail.ru`, `yahoo.com`) where exact email-address matching is required. A client does not need to be the creator/owner of the meeting; attendee inclusion is sufficient.

For branding, every webpage should always show a legal copyright notice (`Copyright (C) 2026. RR Emerge LLC`). The advisor portal and client availability page should show a default letsconnect.ai logo at the top, and the advisor should be able to upload and use their own logo for white-labeling. When advisor logo branding is active, the footer should also include `Powered by LetsConnect.ai`.

When a client is viewing the advisors calendar, maybe there is a way for the client to grant temporary, one session only read privilidge to the clients browser for pulling their google calendar events. If that is possible, we could then compare the clients own calendar and the advisors calendar we pulled to the browser, and the browser's javascript would compare and suggests slots that are open for both.

The advisor_invite_email should by default be the Google login used for advisor portal login. The advisor should be able to modify advisor_invite_email in the advisor portal, and also set preferred advisor name and advisor timezone there. Preferred name should default from Google login/profile, and timezone should default to America/Los_Angeles.

It is desirable that when the agent is deployed it does not have any pre-knowledge of the identity of the advisor. In fact the same agent should have the ability to service multiple advisors and must keep their data separate. Each advisor will have their own clients, and settings as created in the advisor portal. Toward that each advisor must be able to pick their own agent name for like the current default agent@agent.letsconnect.ai. For instance lets say it would be manoj.agent@agent.letsconnect.ai for manoj and lalita.agent@agent.letsconnect.ai for lalita by default. The advisor can then change the name of the agent if they desire to do so by modifying the name in their portal.

The agent must repond only to emails from the advisor or existing clients. Anyone listed in the advisor email get added as clients. Or the advisor may bulk import clients into the advisor portal. There should be no other way to add clients. This way we ensure that unknown persons do not get a response from the agent at all. Any email from an unknown source should be blackholed with no response.

The agent currently is built assuming a single advisor. It turns out multiple advisors want to use the same agent. So once the agent is deployed on the cloud, the advisor portal should allow any advisor to login with their google credentials. Once an advisor logs in, the agent creates their advisor account. They will have their own set of clients, policy profiles, calendars they connect to etc. These are already existing in the advisor profile correctly as required. We only need to make sure that we can do this for multiple different advisors concurrently from the same agent. Each advisors data must be kept separate from the others (for instance oauth keys to their calendars, client lists etc). Each advisor must be able to pick their own agent name for like the current default agent@agent.letsconnect.ai. For instance lets say it would be manoj.agent@agent.letsconnect.ai for manoj and lalita.agent@agent.letsconnect.ai for lalita by default. The advisor can then change the name of the agent if they desire to do so by modifying the name in their portal.

The advisor would like to know how many tokens are being consumed for their account so they have an idea of what their billing would look like. Any other stats that indicate costs should be included there so the advisor can track if they can afford the service. 
