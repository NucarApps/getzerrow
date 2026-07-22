# CASA Readiness & OAuth Scope Justification

Reference for the Google OAuth restricted-scope verification (project
`projectinboxzero-495314`) and the CASA Tier 2 security assessment (due
**2026-08-25**, annual thereafter). This captures the per-scope least-privilege
justification (OAuth verification) and a controls overview (CASA Self-Assessment
Questionnaire / OWASP ASVS).

## 1. OAuth scope justification (least privilege)

Scopes are declared in `src/lib/google-oauth.server.ts` (`GMAIL_SCOPES`).

| Scope                      | Class         | Why it's required                                                                                                                                                                                                                                                                                                                                                           | Where used                                                                                          |
| -------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `gmail.modify`             | Restricted    | Apply/remove Gmail labels to route mail into user-defined folders, mark read, and trash on the user's behalf. Core product function.                                                                                                                                                                                                                                        | `batchModifyMessages`, `/messages/{id}/modify`, `/messages/{id}/trash` in `src/lib/gmail.server.ts` |
| `gmail.send`               | Restricted    | Send replies and forwards the user composes in-app.                                                                                                                                                                                                                                                                                                                         | `/messages/send` in `src/lib/gmail.server.ts`                                                       |
| `gmail.readonly`           | Restricted    | Declares explicit read intent for the message-fetch and parse paths (`getMessage`/history sync in `src/lib/gmail.server.ts`) independent of the write grant. `gmail.modify` also grants read, so this overlaps; we **keep it this cycle** rather than change the consent screen and re-trigger verification mid-assessment. Revisit dropping it at the next annual renewal. | message reads / history sync in `src/lib/gmail.server.ts`                                           |
| `calendar.readonly`        | Sensitive     | Build the known-correspondent list ("cold email guard") from past calendar attendees so first-contact senders can be flagged. Read-only.                                                                                                                                                                                                                                    | `src/lib/calendar.server.ts` → `calendar_contacts`                                                  |
| `userinfo.email`, `openid` | Non-sensitive | Identify the connected mailbox.                                                                                                                                                                                                                                                                                                                                             | OAuth callback                                                                                      |

Sync is incremental via Gmail push (Pub/Sub `watch`/`stop`) and history, not bulk
polling — consistent with minimal, purpose-limited access.

## 2. Security controls overview (for the SAQ / ASVS)

> A per-chapter ASVS L2 → control → evidence map (for pasting into the assessor's SAQ) lives
> in [`casa-asvs-map.md`](./casa-asvs-map.md). The list below is the narrative summary.

- **Encryption in transit** — HTTPS everywhere (Cloudflare); HSTS 2y + preload,
  strong CSP, `X-Frame-Options: DENY`, `nosniff`, restrictive `Permissions-Policy`
  (`src/server.ts`).
- **Encryption at rest** — Sensitive columns (email subject/snippet/body, recipient
  lists, AI summaries, reply drafts, contact PII) are pgcrypto-encrypted with a
  server-held `EMAIL_ENC_KEY` passed per-call; OAuth tokens encrypted via
  `get/set_gmail_oauth_tokens` RPCs. Managed Postgres adds disk-level encryption.
- **Access control** — Supabase Row-Level Security scopes every table to `auth.uid()`;
  `SECURITY DEFINER` RPCs are revoked from `public`/`anon`/`authenticated` and granted
  only to `service_role`. The service-role key is server-only (`*.server.ts`).
- **Authentication** — Google OAuth / OIDC via Supabase (passwordless). Stateless
  HMAC-signed OAuth state with timing-safe comparison and 10-min expiry
  (`signState`/`verifyState`). Cron/webhook endpoints require a `CRON_SECRET` bearer
  with constant-time compare (`src/lib/cron-auth.server.ts`).
- **Input validation / injection** — Zod validators on server functions; Supabase
  parameterized queries (no raw SQL); DOMPurify + a sandboxed, opaque-origin iframe
  for email HTML; ReDoS bounds on user-supplied filter regexes (`filter-engine.ts`).
  SSRF guard on the logo proxy (`src/routes/api/public/logo.ts`).
- **Secrets management** — All secrets in Cloudflare Worker secrets / `.dev.vars`
  (gitignored); only the public Supabase anon key and URL are in `.env`. Templates:
  `.env.example`, `.dev.vars.example`. No secrets in source or git history.
- **Dependency / vuln management** — bun is canonical (single lockfile); CI runs
  `bun audit --prod` + Semgrep SAST (`p/secrets`, `p/owasp-top-ten`, `p/javascript`)
  - tests on every PR (`.github/workflows/ci.yml`); Dependabot watches deps and
    Actions (`.github/dependabot.yml`). A `minimumReleaseAge` guard (`bunfig.toml`)
    blocks <24h-old releases (supply-chain hygiene).
- **Logging & audit** — Structured JSON logs; no decrypted content is ever logged.
  Security-lifecycle events emit `audit.*` records (metadata only): `gmail.connected`,
  `gmail.disconnected`, `account.deleted`, `rules.feedback_flagged` (`logAudit` in
  `src/lib/log.server.ts`). Every cron writes a table-backed run row to
  `pubsub_events` (metadata only) — the rules-engine crons via `logCronRunEvent`
  (`src/lib/sync/cron-run-log.server.ts`). Rule executions are audited per email in
  `executed_rules` (classification reason encrypted).
- **Data retention & deletion** — Disconnecting a mailbox revokes the Google grant and
  purges that mailbox's synced content (`disconnectGmailAccount`). Full account
  deletion erases all user data across every table + the auth user
  (`deleteAccount` in `src/lib/account.functions.ts`). Operational tables
  (`pubsub_events`, dead-letter jobs, `scheduled_actions`, `digest_items`) are pruned
  by the daily retention cron (`cleanup_old_*` service-role RPCs; error/DLQ rows kept
  longer for forensics). Behavior matches the published privacy policy
  (`src/routes/privacy.tsx`).
- **AI processing disclosure** — Email content is sent to the Lovable AI gateway for
  folder classification/summaries only (`src/lib/ai.server.ts`); disclosed in the
  privacy policy. No tokens/secrets are included in AI payloads.
- **Rules engine (2026-07 upgrade)** — Deterministic rules-first classification with a
  per-email audit trail and user-configurable actions. New tables (all owner-RLS'd,
  indexed, tested): `executed_rules`/`executed_actions` (audit log, task 1),
  `folder_actions`/`scheduled_actions` (action fan-out + delayed queue, tasks 4–5),
  `digest_items`/`user_settings` (digest, task 9), `classification_feedback`
  (task 12); plus columns `folders.run_on_threads` (task 6) and
  `contact_groups.kind` (task 7). Sensitive action config (webhook secrets, reply
  templates) is encrypted and reachable only via service-role RPCs
  (`get/set_folder_action_webhook`, `set_folder_action_template` /
  `get_folder_action_outbound`); queue claiming via `claim_scheduled_actions`
  (`SKIP LOCKED` + lease). New cron endpoints (all `CRON_SECRET`-gated, fail closed):
  `hooks/run-scheduled-actions` (1m), `hooks/categorize-senders` (nightly),
  `hooks/send-digest` (hourly). User-facing AI surfaces (rule proposals, sender
  categories, digest overviews) treat model output as untrusted — strict Zod
  validation, bounded inputs inside `<untrusted_email>` boundaries, timeboxed calls,
  deterministic fallbacks. Per-task detail in `docs/rules/*.md`; control → evidence
  rows in `casa-asvs-map.md` (V4–V7, V11).

## 3. Known items to track

- `gmail.readonly` / `gmail.modify` read overlap (§1) — keeping `gmail.readonly` this cycle;
  reconsider dropping it at the next annual renewal (consent-screen change → re-verification).
- `brace-expansion` advisory (GHSA-jxxr-4gwj-5jf2) is **dev-only** (eslint toolchain),
  excluded from the prod audit gate; clears on the next eslint major bump.
- CI `lint` step is enforced with `--max-warnings=0` (resolved — commit `c97b980`).
- Duplicate `executed_rules` migration files: `20260721183630_cdaeab8d-….sql` is
  Lovable's re-record of `20260721210000_executed_rules_audit_log.sql` as applied to
  prod (identical objects, comment/order differences only). Prod is unaffected; a
  fresh-database replay must skip one of the two. Migrations are immutable by project
  ground rules, so this is documented rather than edited.
- Rules-upgrade migrations pending prod apply are tracked per task in
  `docs/rules/*.md` (tasks 4–9, 12–13 added tables/RPCs/crons). `LOVABLE_API_KEY`
  is the only AI credential; all AI calls go through the Lovable gateway, timeboxed.
