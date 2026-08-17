# financeAgentJobQueue

An async job queue where one job type is a genuinely agentic, multi-step Claude loop — not a single API call bolted onto a queue. Companion project to [urlShortener](https://github.com/cw00d16/urlShortener) and [chatApplication](https://github.com/cw00d16/chatApplication) — same serverless-on-AWS-with-Terraform conventions, and the guardrail/observability/eval-harness patterns proven in chatApplication's `@agent` feature carry over directly here.

**Status: design phase.** This README is the plan for the initial build, not documentation of code that exists yet.

## The domain: company research

Two job types, sharing one purpose — researching a company — at opposite ends of the cost/complexity spectrum:

1. **Extraction** (cheap tier) — one document in, one fixed JSON shape out. Cheap model, one Claude call, no tools, deterministically checkable.
2. **Research** (agentic tier) — a company name in, a synthesized report out. Multiple tool-use rounds (web search, self-verification), consumes the structured facts extraction already collected instead of starting from nothing.

Extraction is the "collect facts from documents" tier; research is the "synthesize across facts + live information" tier. The second builds on the first's output — that's what makes this one system instead of two disconnected demos.

### Extraction schema (earnings release / earnings call)

Fields are chosen by working backward from what the research job needs to say, not by brainstorming anything that sounds financial:

```json
{
  "company": "Acme Corp",
  "ticker": "ACME",
  "fiscalPeriod": "Q1 2026",
  "revenue": { "actual": 1240000000, "yoyGrowthPct": 12.4 },
  "eps": { "gaap": 1.15, "nonGaap": 1.32 },
  "operatingMarginPct": 22.1,
  "guidance": { "nextPeriodRevenue": "1.28B-1.32B", "changedFromPriorGuidance": true },
  "segmentBreakdown": [{ "name": "Cloud", "revenue": 700000000 }, { "name": "Hardware", "revenue": 540000000 }],
  "notableEvents": ["announced restructuring", "CFO transition"],
  "managementQuotes": ["\"We're seeing strong momentum in enterprise adoption\" — CEO"]
}
```

The schema is fixed by the system, not the caller — same reasoning as chatApplication's eval fixtures: you can't write a deterministic check (or a rubric) against a shape you don't know in advance. V1 covers this one document type only; other document types (10-K excerpts, press releases) are a natural v2 extension, not a launch requirement.

## Architecture

```
POST /jobs ── submitJob Lambda ── writes job record to DynamoDB (jobs table)
                                          │
                          ┌───────────────┴───────────────┐
                          ▼                                ▼
                 extraction-queue (SQS)              research-queue (SQS)
                 short visibility timeout             long visibility timeout
                          │                                │
                          ▼                                ▼
                  extractWorker Lambda               researchWorker Lambda
                  (Haiku, single call,                (multi-step tool-use
                   no tools)                            loop, web search)
                          │                                │
                          └──────────► jobs table ◄────────┘
                                    (status, result, cost)

GET /jobs/{id} ── getJob Lambda ── reads job record
```

- **Job submission**: `POST /jobs` writes one DynamoDB item (`jobs` table: `jobId`, `type`, `status`, `input`, `result`, `createdAt`, token/cost totals) and enqueues to whichever SQS queue matches the job type.
- **Two queues, not one** — extraction and research jobs have genuinely different SLAs. A stuck extraction job should be considered failed and retried within a couple of minutes; a research job doing several tool-use rounds legitimately needs a much longer visibility timeout before SQS assumes the worker died and redelivers it. One queue with one timeout would either kill research jobs mid-loop or leave failed extraction jobs invisible for too long.
- **Result delivery is polling, not real-time push.** chatApplication needed a WebSocket because chat messages are inherently live; a job result isn't — the caller submits and checks back. A `GET /jobs/{id}` endpoint is simpler, cheaper, and the right tool for this shape of problem. No API Gateway WebSocket, no `connect`/`disconnect`/`fanout`/`deliver` needed here.
- **Input documents live directly on the job record** (DynamoDB item, well within the 400KB item limit for text like a transcript or filing excerpt) rather than S3. Simpler for v1 with no bucket/IAM to provision; S3 becomes worth it if this ever needs to accept actual file uploads (scanned PDFs needing OCR, etc.) rather than pasted/fetched text.

### Fan-out / fan-in: research jobs depending on extraction jobs

A research job can name several source documents it wants extracted first. Rather than a Lambda holding its 15-minute execution open and polling for those to finish (wasteful — burns invocation time paying for nothing), the fan-in is event-driven, echoing the `fanout`/`deliver` pattern from chatApplication but as a job dependency graph instead of a delivery fan-out:

1. The research job record stores `pendingExtractionCount: N` and its own status stays `waiting`.
2. Each extraction job, on completion, decrements that counter on its parent's record via an atomic DynamoDB update.
3. Whichever completion brings the counter to zero enqueues the research job onto `research-queue`.

No worker ever sits idle waiting on another worker.

## Guardrails

Everything here is a direct reuse of what chatApplication's `@agent` guardrails proved out, applied to a queue instead of a chat room:

- **Per-job token/tool-call budget**, enforced inside the research worker's own loop — a hard iteration cap so one wandering agentic job can't run away. Unlike chatApplication's per-user rate limit (which needed its own DynamoDB table because it spans requests), this budget is scoped to one job's one execution, so it just lives in memory for that invocation — no extra table needed.
- **Capped retries → dead-letter queue**, not infinite reprocessing. A permanently-failing job shouldn't get retried at Claude's expense forever; SQS redrive policy sends it to a DLQ after N attempts instead.
- **Idempotency on `jobId`** — SQS is at-least-once delivery, so a worker checks the job's current status before processing and no-ops if it's already `succeeded`/`failed`. Without this, a redelivered message could call Claude twice for the same job.
- **Least-privilege IAM per worker**, separate roles — `extractWorker` only needs `GetItem`/`UpdateItem` on `jobs` and read of its own secret; `researchWorker` additionally needs web search tool access. Neither needs anything else.
- **Secrets in Secrets Manager**, fetched once per cold start and cached — same pattern, no plaintext env vars.

## Observability

Same shape as chatApplication: structured JSON logs per job (`jobId`, `type`, `outcome`, `inputTokens`, `outputTokens`, `latencyMs`) turned into CloudWatch metrics via metric filters, feeding a dashboard (jobs by outcome, latency, estimated spend by job type, DLQ depth) and alarms. One addition specific to a queue system: a **DLQ-depth alarm** — jobs landing in the dead-letter queue at all is a signal something is systematically broken, not just a per-job hiccup, and there's no equivalent signal in a system without a queue.

## Eval harness

Same pattern as chatApplication, adapted per job type:

- **Extraction fixtures**: sample documents with a known-correct structured result. Grading is almost entirely deterministic — does the output match the schema, and does it reconcile arithmetically (do segment revenues sum sensibly, is the guidance range well-formed) — the same "check the math, not just the vibes" approach as the invoice-style validation discussed earlier.
- **Research fixtures**: judge-graded (Haiku, rubric-based) — "does the report actually address the fiscal period in question," "does it use the extracted facts rather than ignoring them."
- Cost bounded by construction, not by hoping fixtures stay small — fixed `max_tokens` caps and defensive truncation of fixture text in the runner itself, same as chatApplication's harness. Wired into CI the same way: a job-type regression blocks deploy.

## Keeping this cheap

This is a pet project, and the design leans on that everywhere it can:

- **Fully serverless, pay-per-use, nothing provisioned that idles** — Lambda, SQS, DynamoDB (`PAY_PER_REQUEST`), API Gateway. No idle server, no NAT gateway, no VPC (the classic AWS pet-project cost trap — a NAT gateway alone runs ~$32/month sitting there doing nothing). If nothing runs, nothing bills, the same way chatApplication costs nothing between messages.
- **Cheapest model that clears the bar, for both tiers, until proven insufficient** — start both `extractWorker` and `researchWorker` on Haiku 4.5, same as chatApplication ended up on after measuring real cost. Upgrade `researchWorker` to Sonnet only if the eval harness actually shows Haiku falling short on synthesis quality — don't pre-pay for capability that isn't needed yet.
- **Hard per-job budgets** (above) mean a bug in the agentic loop costs at most one capped job, never an unbounded bill.
- **Batch API is a later lever, not a v1 one.** Its 50%-off discount is proportional to volume, and a pet project's volume is low by definition — the actual dollar savings at low volume are small. Worth designing the workers so it's a drop-in swap later (batching is naturally suited to an async worker that already doesn't need low latency), but not worth the added complexity (submit-then-poll-for-batch-completion) until job volume actually justifies it.
- **CloudWatch log retention capped at 14 days** (matching chatApplication) — no indefinite log storage cost.
- **A daily-spend CloudWatch alarm from day one** (same pattern as chatApplication) rather than checking the AWS bill after the fact.

Rough expectation for light personal use — a handful of test jobs a day — is a few cents a day in Claude spend at Haiku pricing, comfortably inside AWS's Lambda/SQS/DynamoDB free tiers for the infra itself. That's an estimate, not a measurement — same as I told you honestly on chatApplication's caching claim, this gets confirmed for real once the eval harness exists and can print real numbers, not asserted in advance.

## Planned tech stack

- **Compute**: AWS Lambda (Node.js, matching chatApplication)
- **Queue**: SQS (two queues + two DLQs)
- **Data**: DynamoDB (`jobs` table), `PAY_PER_REQUEST`
- **API**: API Gateway HTTP API (`submitJob`, `getJob`)
- **IaC**: Terraform, same conventions as chatApplication (per-function IAM roles where least privilege matters, OIDC for CI, no long-lived AWS keys)
- **Secrets**: Secrets Manager for the Anthropic API key
- **Model**: Claude Haiku 4.5 for both job types initially; Sonnet as a measured upgrade path for `researchWorker` only if needed
