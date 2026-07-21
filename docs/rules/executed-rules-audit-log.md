# Task 1 — `executed_rules` + `executed_actions` audit log

Every classification execution now leaves an audit trail: one
`executed_rules` row per ingested email, recording which folder the mail
went to, what decided it (rule, Gmail label, AI, override, …), which rule
conditions fired, and why. A "Rule activity" settings page surfaces the
last 500 decisions.

## Schema (`supabase/migrations/20260721210000_executed_rules_audit_log.sql`)

**`executed_rules`** — one row per classification execution:

| column               | notes                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email_id`           | FK → `emails`, `ON DELETE CASCADE` — mailbox disconnect / account deletion purges audit rows with the content they describe                         |
| `folder_id`          | FK → `folders`, `ON DELETE SET NULL` — deleting a folder keeps the history                                                                          |
| `classified_by`      | same vocabulary as `emails.classified_by` (`filter`, `domain_rule`, `gmail_label`, `ai`, `inbox_override`, `excluded`, `surfaced_to_inbox`, …)      |
| `matched_filter_ids` | `folder_filters` row ids for simple-filter matches                                                                                                  |
| `matched_leaf_json`  | the `field/op/value` leaves that fired — from `collectMatchingLeaves` over the folder's `filter_tree`, else the matched `folder_filters` conditions |
| `reason_enc`         | **encrypted** (`private.encrypt_text`, `EMAIL_ENC_KEY`) — see below                                                                                 |
| `status`             | `applied` / `skipped` / `error` / `pending` (semantics below)                                                                                       |
| `automated`          | `true` for the ingest pipeline (the only writer today)                                                                                              |

Indexes: `(user_id, created_at DESC)`, `(folder_id, created_at DESC)`, `(email_id)`.

**`executed_actions`** — per-action child rows (`action_type`, `status`,
`error`, `payload`, `ran_at`). Written by the action dispatcher since
task 4 (`docs/rules/folder-actions-dispatch.md`) with honest per-action
statuses. Its `payload` must only ever hold action _configuration_ (label
ids, forward address), never email content or AI output.

### Encryption deviation from the task spec

The spec sketched `reason TEXT`. Classification reasons can embed AI output
about the email (the AI classifier's `reason`, surface-rule decisions), and
the encryption invariant requires AI output to be encrypted at rest — the
`emails` table already stores the same text as `classification_reason_enc`.
So the column is `reason_enc BYTEA`, written by the service-role-only
`record_executed_rule` RPC and decrypted by the service-role-only
`list_executed_rules` RPC (both mirror the existing encrypted email
read/write RPCs). Everything else in the row — statuses, leaf conditions,
filter ids — is user rule config or metadata and stays plain.

### Access control

- RLS: `SELECT` for `authenticated` with `auth.uid() = user_id`
  (`executed_actions` joins through its parent row). Direct selects see
  ciphertext for the reason.
- Inserts/decrypting reads: `SECURITY DEFINER` RPCs with
  `REVOKE ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role`.

## Status semantics

| status    | meaning                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `applied` | the classification outcome was persisted — routed to a folder, kept in inbox by an override, surfaced, or plain no-match         |
| `skipped` | a candidate existed but was deliberately not applied: exclude-rule veto, AI below `min_ai_confidence`, calendar cold-email guard |
| `error`   | classification failed (`ai_error` / `unclassified`); `error` carries the message                                                 |
| `pending` | AI deferred to the backfill batch lane (`skipAi`); the email row is `pending_ai`                                                 |

## Write path (`src/lib/sync/executed-rules.ts`)

`recordExecution(...)` is called from **one funnel at the end of the
classify path** in `processGmailMessage` — the rules-final, deferred-AI,
AI-success, and AI-failure branches all converge on it, so a normal ingest
produces **exactly one row per email**. A retry that completes a stuck
`pending`/`pending_ai` classification records its own row (the log records
executions; the newest row is the effective state).

The insert is **best-effort**: failures are logged via
`logError("executed_rules.record_failed", …)` with metadata only (never the
reason text) and never block or fail message processing.

Known gap (accepted for task 1): emails whose deferred AI completes in the
backfill _batch_ pass keep their `pending` row — the batch lane lives
outside `process-message.ts` and will be wired when the audit log grows
action rows (task 4).

## Read path & UI

- `listExecutedRules` server fn (`src/lib/executed-rules.functions.ts`):
  auth-gated, passes the authenticated `userId` to the decrypting RPC,
  optional account/folder filters, limit ≤ 500.
- Settings page `src/routes/_authenticated/settings.rule-activity.tsx`
  ("Settings → Rule activity"): account picker, folder filter, last-500
  table with expandable rows (full reason, matched conditions, AI
  confidence, error, Gmail message id). Auto-refreshes every 15s.

## Tests

`src/lib/sync/executed-rules.test.ts` drives the real module through
`processGmailMessage`: rules match (tree + simple-filter variants), AI
match, exclude veto (`skipped`), classify failure (`error`), deferred lane
(`pending`), best-effort RPC failure, stuck-pending retry, plus the
`statusForClassification` mapping table. `process-message.test.ts` mocks
the module and keeps its existing pipeline contracts unchanged.
