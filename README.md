# Zerrow — AI inbox for Gmail

Zerrow connects to Gmail and sorts incoming mail into user-defined folders —
deterministic rules first, AI classification second — then acts on it:
labels, replies, drafts, webhooks, digests. Every decision is audited and
explainable, and email content is encrypted at rest.

**Stack:** TanStack Start (React 19) on Cloudflare Workers · Supabase
Postgres (RLS, pgcrypto, pg_cron) · Gmail API with Pub/Sub push sync ·
Lovable AI gateway for all model calls.

## Getting started

```sh
bun install
cp .env.example .env            # public build-time vars (Supabase URL + anon key)
cp .dev.vars.example .dev.vars  # server secrets — see the file for the full list
bun run dev
```

Verification (all must be green before a PR):

```sh
bun run test                    # vitest unit suite
bunx tsc --noEmit               # typecheck
bun run lint                    # eslint (CI enforces --max-warnings=0)
bun run build                   # Cloudflare Workers bundle
```

Database changes live in `supabase/migrations/` (append-only —
`YYYYMMDDHHMMSS_slug.sql`, one logical change per file, never edit an
applied migration). Server-only code is isolated in `*.server.ts` modules;
the browser bundle only ever sees the public Supabase anon key.

## Rule engine

Incoming mail is classified **rules first**: deterministic filter trees are
evaluated before the emails row is written, and the AI classifier only sees
messages the rules didn't decide. Every execution is recorded in
`executed_rules` (matched conditions, confidence, encrypted reason) and
surfaced in the UI — the reader's "Why this folder?" link and the rule
activity page in settings. Per-feature design notes live in
[`docs/rules/`](docs/rules/).

### Filter trees

A folder's rule is a nested tree of `and`/`or` groups over conditions
(`field · op · value`). Fields: `from`, `to`, `cc`, `subject`, `body`,
`domain`, `list_id`, `is_reply`, `has_attachment`. Ops: `contains`,
`not_contains`, `equals`, `not_equals`, `starts_with`, `ends_with`,
`regex`, `domain_in`, `sender_in_group`. Trees are bounded everywhere they
enter the system (max depth 8, max 128 conditions, regex patterns ≤ 200
chars against bounded input) — see `validateRuleNode` in
`src/lib/sync/filter-engine.ts` and
[`docs/rules/filter-tree-caps.md`](docs/rules/filter-tree-caps.md).

### Actions

Folders trigger actions when mail routes into them: explicit per-folder
rows in `folder_actions` (archive, mark read, star, label, move, reply,
draft, send email, call webhook, digest, …), each with an optional delay of
up to 24 h. Delayed and outbound work goes through the `scheduled_actions`
queue — claimed with a lease (`SKIP LOCKED`), retried with exponential
backoff, parked as DLQ rows after 6 attempts, aged out by the retention
cron. The legacy folder flags (`auto_archive`, `auto_mark_read`, …) keep
working as implicit actions. Reply/draft templates use whitelisted tokens
only and are stored encrypted; webhook deliveries are HMAC-signed and
SSRF-guarded. See [`docs/rules/folder-actions-dispatch.md`](docs/rules/folder-actions-dispatch.md),
[`docs/rules/webhook-action.md`](docs/rules/webhook-action.md), and
[`docs/rules/outbound-actions.md`](docs/rules/outbound-actions.md).

### Thread scope

Folders with `run_on_threads` enabled follow the conversation: once a rule
routes a message, later replies in the same thread land in the same folder
without re-matching. See [`docs/rules/thread-scope-rules.md`](docs/rules/thread-scope-rules.md).

### Sender categories

A nightly job asks the AI to bucket recent senders into a fixed category
set (recruiters, vendors, newsletters, customers, personal, services) and
maintains them as `kind='ai_category'` contact groups — so a rule like
`sender_in_group(Recruiters)` keeps working as new senders appear. Bounded
per run, sender addresses/names only (never bodies). See
[`docs/rules/ai-sender-categories.md`](docs/rules/ai-sender-categories.md).

### Digests

The `digest` action collects routed mail into a daily or weekly summary
email instead of interrupting — reference rows only (`digest_items`), sent
hourly when the user's local clock (per-user hour/timezone/weekday in
`user_settings`) says it's time, with an optional AI overview and a plain
fallback. Always mails the user's own mailbox. See
[`docs/rules/digest-action.md`](docs/rules/digest-action.md).

### Simulator

The folder editor's dry-run answers "what would this rule have done?"
against the last 1/7/30 days of real mail (up to 1 000 messages) without
writing anything: would-move, vetoed-by-exclusion, and untouched counts
plus a sample list. Deterministic only — no AI involved. See
[`docs/rules/rule-simulator.md`](docs/rules/rule-simulator.md).

### Rule from example

Right-click an email → "Make rule from this email…" and the AI proposes a
folder name + filter tree, which you can rename, preview through the
simulator, and create with one click. Model output is treated as
untrusted: strict schema validation, the same tree bounds as the save
path, whitelist-only actions (never webhooks/outbound), and a
deterministic sender-domain fallback when the proposal doesn't validate.
The feedback loop closes the circle: flagging a wrong classification
re-files the email and stores an encrypted few-shot example for the right
folder. See [`docs/rules/rule-from-email.md`](docs/rules/rule-from-email.md)
and [`docs/rules/classification-feedback.md`](docs/rules/classification-feedback.md).

## Security model (short version)

- **Encryption at rest** — email bodies/subjects/snippets, recipient
  lists, AI output, reply templates, webhook secrets, and OAuth tokens are
  pgcrypto-encrypted with a server-held `EMAIL_ENC_KEY`.
- **Row-Level Security everywhere** — every user table is scoped to
  `auth.uid()`; `SECURITY DEFINER` RPCs are service-role-only.
- **Fail closed** — cron/webhook endpoints require `CRON_SECRET` (or the
  Pub/Sub token) with constant-time comparison.
- **Bounded untrusted input** — rule trees, regexes, templates, and AI
  prompts/outputs are length- and shape-checked; AI calls are timeboxed
  and go through the Lovable gateway only.

The full control → evidence map for the CASA Tier 2 assessment is in
[`docs/casa-readiness.md`](docs/casa-readiness.md) and
[`docs/casa-asvs-map.md`](docs/casa-asvs-map.md). Deployment/upgrade order
for the rules engine is in
[`docs/rules/upgrade-notes.md`](docs/rules/upgrade-notes.md).
