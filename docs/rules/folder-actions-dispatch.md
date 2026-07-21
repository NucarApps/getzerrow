# Task 4 — `folder_actions` + `scheduled_actions` + action dispatcher

Actions are decoupled from folder columns. Folders can now carry explicit
per-action rows, while the legacy flags keep working unchanged as
implicit actions.

## Schema (`supabase/migrations/20260721230000_folder_actions_and_scheduled.sql`)

- **`folder_actions`** — one row per configured action:
  `action_type` (full 14-type vocabulary from the spec), `label_id`,
  `move_to_folder_id` (added — the spec sketch had no way to express a
  move target), template/recipient/webhook/digest columns reserved for
  later tasks, `delay_minutes` (0–1440), `enabled`. Partial index on
  `(folder_id) WHERE enabled`. Owner-scoped RLS `FOR ALL` with a
  folder-ownership `WITH CHECK`.
- **`scheduled_actions`** — the delayed-execution queue:
  `folder_action_id`, `email_id`, `run_at`, `status`
  (`pending/running/done/error/cancelled`), `attempt`, `last_error`,
  `claimed_at`. Partial index on `(run_at) WHERE status='pending'`. Users
  can read and cancel their own rows; only the server-side dispatcher
  inserts.
- `body_template_enc` / `webhook_secret_enc` are BYTEA and **must only be
  written via encrypting service-role RPCs** — nothing writes them yet
  (tasks 5 and 8).

## Dispatcher (`src/lib/sync/action-dispatch.ts`)

Implemented types: `archive`, `mark_read`, `star`, `label`,
`move_folder`. Everything else reports an `error` outcome
("action not implemented") without breaking mail processing — those types
land in later tasks.

Key design decisions:

- **Handlers contribute to one MutationPlan** (label adds/removes + a
  row patch) instead of calling Gmail/DB themselves. applyFolderActions
  executes the plan as ONE `modifyMessage` call and ONE emails update —
  identical batching, ordering, and realtime behavior to the
  pre-dispatcher code. `mergeFlagActions` emits synthetics in the
  legacy order (label → UNREAD → STARRED → INBOX) so the Gmail arrays
  stay byte-identical for flag-only folders.
- **Flags as implicit actions**: `auto_archive`/`hide_from_inbox` →
  `archive`, `auto_mark_read` → `mark_read`, `auto_star` → `star`,
  `gmail_label_id` → `label` — unless an explicit enabled row of that
  type exists, which overrides the flag. `snooze_hours` and `forward_to`
  remain legacy column behaviors until their action types land.
- **Idempotency**: every handler checks current state (labels, existing
  plan entries) — an action whose end-state already holds contributes
  nothing and reports `skipped`.
- **persistFlags semantics preserved**: synthetic actions skip their
  local patch when `persistFlags=false` (the INSERT already carried the
  flag-derived state); explicit rows always patch, since their effects
  are never folded into the insert.
- **Delays**: an explicit row with `delay_minutes > 0` enqueues a
  `scheduled_actions` row (`pending`) instead of running inline. The
  runner cron lands with the webhook action (task 5) — until then the
  queue only accumulates if someone configures a delay (no UI creates
  rows yet).

## Audit trail

`applyFolderActions` returns per-action outcomes (including the legacy
forward), and the classify funnel passes them to `recordExecution`, which
inserts `executed_actions` child rows under the email's `executed_rules`
row — closing the "no code writes executed_actions yet" gap from task 1.
Payloads carry action configuration only (label ids, target folder,
forward address), never email content or AI output.

## Tests

`action-dispatch.test.ts` (18): flag mapping + ordering, explicit-row
override, per-type behavior + idempotency for all five implemented types,
delayed enqueue (+ missing-user error), unimplemented-type error
isolation, synthetic-vs-explicit patch gating, and an applyFolderActions
integration case proving one Gmail call with an override label. All
existing suites (process-message, executed-rules, rescue, classify) stay
green — acceptance: behavior for folders with no `folder_actions` rows is
unchanged.
