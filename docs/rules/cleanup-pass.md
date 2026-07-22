# Cleanup pass (rules upgrade, task 13)

End-of-project audit of everything the rules-engine upgrade (tasks 1–12)
added, plus the fixes the audit produced. Anything marked **added here**
shipped in this task; everything else was verified already in place.

## Table audit — indexes / RLS / tests / ASVS

| Table                     | Task | Indexes                                | RLS                                        | Tests                                                 | ASVS map |
| ------------------------- | ---- | -------------------------------------- | ------------------------------------------ | ----------------------------------------------------- | -------- |
| `executed_rules`          | 1    | ✓ user+created, folder+created, email  | ✓ read-own; writes via service-role RPCs   | `executed-rules.test.ts`                              | V4, V6   |
| `executed_actions`        | 1    | ✓ rule id                              | ✓ read-own via parent; service-role writes | `action-dispatch.test.ts`                             | V4       |
| `folder_actions`          | 4    | ✓ folder (partial, enabled)            | ✓ owner ALL + folder-ownership WITH CHECK  | `action-dispatch.test.ts`, `outbound-actions.test.ts` | V4, V6   |
| `scheduled_actions`       | 4    | ✓ due (partial, pending), user+created | ✓ read/cancel-own; server-side inserts     | `webhook-action.test.ts`, `outbound-actions.test.ts`  | V4       |
| `digest_items`            | 9    | ✓ pending (partial, unsent)            | ✓ owner ALL                                | `digest-actions.test.ts`                              | V11      |
| `user_settings`           | 9    | ✓ PK (user_id)                         | ✓ owner ALL                                | `digest-actions.test.ts` (due-bucket logic)           | V11      |
| `classification_feedback` | 12   | ✓ user+created                         | ✓ owner ALL (USING + WITH CHECK)           | `classification-feedback.test.ts`                     | V11      |

Columns added to existing tables (`contact_groups.kind`,
`folders.run_on_threads`, `folder_actions.*_template*/to_addr/…`) ride the
parent table's existing RLS/indexes; each has its own test file
(`categorize-senders.test.ts`, `filter-engine.thread.test.ts`,
`outbound-actions.test.ts`).

## Cron audit — idempotency / run log / DLQ

| Cron (pg_cron → endpoint)                                  | Idempotency                                                                           | Run log                                                                          | DLQ / failure path                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `run-scheduled-actions-1m` → `hooks/run-scheduled-actions` | `claim_scheduled_actions` RPC: `FOR UPDATE SKIP LOCKED`, 5-min lease, attempt counter | **added here** — `pubsub_events` row per non-idle tick (`scheduled_actions_run`) | exponential backoff, terminal park at `status='error'` + `last_error`; **added here**: aged out by retention |
| `categorize-senders-nightly` → `hooks/categorize-senders`  | only uncategorized senders selected; `ensureGroup` reuses existing AI groups          | **added here** — `pubsub_events` row per tick (`categorize_senders_run`)         | per-user isolation (one user's failure never blocks the rest); uncategorized senders retry next night        |
| `send-digest-hourly` → `hooks/send-digest`                 | `sent_at` stamp — only unsent items selected, stamped in the same run                 | **added here** — `pubsub_events` row per sending tick (`send_digest_run`)        | failed sends leave items unsent → retried next hour; sent rows **added here**: aged out by retention         |

All three endpoints fail closed (`isAuthorizedCronRequest` → 401) — now
also covered by `tests/public-endpoints-auth.test.ts` (see below).

## Fixes shipped in this task

- **`cleanup_old_scheduled_actions` + `cleanup_old_digest_items`**
  (`20260722080000_rules_ops_retention.sql`) — batched, `SKIP LOCKED`,
  service-role-only retention functions mirroring
  `cleanup_old_pubsub_events`. Wired into the daily
  `/api/public/gmail-retention` cron (new `scheduled_*`/`digest_*` query
  params, response fields, and audit-row details). Live queue rows
  (`pending`/`running`, unsent digest items) are never touched; `error`
  rows — the queue's DLQ — are kept twice as long (60d vs 30d) for
  forensics, matching the pubsub_events error-row policy.
- **`logCronRunEvent`** (`src/lib/sync/cron-run-log.server.ts`, tested in
  `cron-run-log.test.ts`) — table-backed run log for the three
  rules-upgrade crons, closing the gap with every older cron that already
  writes one `pubsub_events` row per tick. Bounded details, metadata
  only, swallow-on-failure (a run-log write can never fail the run).
  The every-minute runner logs only non-idle ticks and the hourly digest
  only sending ticks, so idle ticks don't flood the table.
- **Fail-closed test sweep** — `tests/public-endpoints-auth.test.ts` was
  missing 14 cron-authed endpoints added since it was written (including
  all three rules-upgrade hooks); the `CRON_ENDPOINTS` list now matches
  every route using `isAuthorizedCronRequest`.
- **`docs/casa-readiness.md`** refreshed with the rules-engine additions
  (tables, RPCs, endpoints, crons) and new known-items.

## Audit outcomes with no code change

- **Renames** — none. Project ground rules forbid file/column renames
  (backward compatibility invariant), and the audit found no "obviously
  wrong" names: migrations use `YYYYMMDDHHMMSS_slug.sql`, modules follow
  the `*.server.ts` / `*.functions.ts` conventions.
- **Feature flags / dead code** — the upgrade introduced no feature
  flags, so there are no dead flagged paths to delete. Legacy folder
  flags (`auto_archive` etc.) are NOT dead code — they intentionally keep
  working as implicit actions (task 4's compatibility contract).
- **Duplicate `executed_rules` migration** — the repo carries both
  `20260721183630_cdaeab8d-….sql` (Lovable's re-record of the SQL as
  applied to prod) and `20260721210000_executed_rules_audit_log.sql`
  (task 1's original). They create identical objects; only comments and
  statement order differ. Existing migrations are immutable per project
  ground rules, so this is documented (here and in
  `casa-readiness.md` §3) instead of edited: a **fresh** replay must skip
  one of the two (prod already has the objects, so prod is unaffected).
- **`semgrep`** — not installed in this workspace; it runs in CI on every
  PR (`.github/workflows/ci.yml`: `p/secrets`, `p/owasp-top-ten`,
  `p/javascript`, `p/typescript`, `--error`), which is the acceptance
  gate that counts.
