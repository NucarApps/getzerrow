# CASA Readiness & OAuth Scope Justification

Reference for the Google OAuth restricted-scope verification (project
`projectinboxzero-495314`) and the CASA Tier 2 security assessment (due
**2026-08-25**, annual thereafter). This captures the per-scope least-privilege
justification (OAuth verification) and a controls overview (CASA Self-Assessment
Questionnaire / OWASP ASVS).

## 1. OAuth scope justification (least privilege)

Scopes are declared in `src/lib/google-oauth.server.ts` (`GMAIL_SCOPES`).

| Scope | Class | Why it's required | Where used |
|-------|-------|-------------------|------------|
| `gmail.modify` | Restricted | Apply/remove Gmail labels to route mail into user-defined folders, mark read, and trash on the user's behalf. Core product function. | `batchModifyMessages`, `/messages/{id}/modify`, `/messages/{id}/trash` in `src/lib/gmail.server.ts` |
| `gmail.send` | Restricted | Send replies and forwards the user composes in-app. | `/messages/send` in `src/lib/gmail.server.ts` |
| `gmail.readonly` | Restricted | Declares explicit read intent for the message-fetch and parse paths (`getMessage`/history sync in `src/lib/gmail.server.ts`) independent of the write grant. `gmail.modify` also grants read, so this overlaps; we **keep it this cycle** rather than change the consent screen and re-trigger verification mid-assessment. Revisit dropping it at the next annual renewal. | message reads / history sync in `src/lib/gmail.server.ts` |
| `calendar.readonly` | Sensitive | Build the known-correspondent list ("cold email guard") from past calendar attendees so first-contact senders can be flagged. Read-only. | `src/lib/calendar.server.ts` → `calendar_contacts` |
| `userinfo.email`, `openid` | Non-sensitive | Identify the connected mailbox. | OAuth callback |

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
  + tests on every PR (`.github/workflows/ci.yml`); Dependabot watches deps and
  Actions (`.github/dependabot.yml`). A `minimumReleaseAge` guard (`bunfig.toml`)
  blocks <24h-old releases (supply-chain hygiene).
- **Logging & audit** — Structured JSON logs; no decrypted content is ever logged.
  Security-lifecycle events emit `audit.*` records (metadata only): `gmail.connected`,
  `gmail.disconnected`, `account.deleted` (`logAudit` in `src/lib/log.server.ts`).
- **Data retention & deletion** — Disconnecting a mailbox revokes the Google grant and
  purges that mailbox's synced content (`disconnectGmailAccount`). Full account
  deletion erases all user data across every table + the auth user
  (`deleteAccount` in `src/lib/account.functions.ts`). Operational tables
  (`pubsub_events`, dead-letter jobs) are pruned by the daily retention cron. Behavior
  matches the published privacy policy (`src/routes/privacy.tsx`).
- **AI processing disclosure** — Email content is sent to the Lovable AI gateway for
  folder classification/summaries only (`src/lib/ai.server.ts`); disclosed in the
  privacy policy. No tokens/secrets are included in AI payloads.

## 3. Known items to track

- `gmail.readonly` / `gmail.modify` read overlap (§1) — keeping `gmail.readonly` this cycle;
  reconsider dropping it at the next annual renewal (consent-screen change → re-verification).
- `brace-expansion` advisory (GHSA-jxxr-4gwj-5jf2) is **dev-only** (eslint toolchain),
  excluded from the prod audit gate; clears on the next eslint major bump.
- CI `lint` step is enforced with `--max-warnings=0` (resolved — commit `c97b980`).
