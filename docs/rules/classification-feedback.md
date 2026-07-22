# Explain classification + feedback (rules upgrade, task 12)

One-tap "this was wrong" from any rule-activity row: pick the right
folder and Zerrow records the feedback, moves the email, and teaches
the corrected folder — in one action.

## Data model

Migration `20260722060000_classification_feedback.sql`:
`classification_feedback(id, user_id, executed_rule_id → executed_rules
ON DELETE CASCADE, correct_folder_id → folders ON DELETE SET NULL,
note ≤500 chars, created_at)` with owner RLS (`USING`/`WITH CHECK
auth.uid()`). Metadata only — no email content.

## Server fns (`src/lib/sync/classification-feedback.functions.ts`)

- `explainExecution(executed_rule_id)` — ownership-checked; returns the
  matched conditions + confidence from the audit row plus
  **deterministic alternative folders**: the email is re-run through
  `matchByFilters` and every other folder whose rules also matched is
  offered (top 3, priority order). *Deviation:* the sketch's "evalNode
  score" doesn't exist — rule matching is boolean, so priority order IS
  the ranking, and no AI is involved. Reason text isn't re-returned:
  `list_executed_rules` already delivers it decrypted.
- `flagWrongClassification(executed_rule_id, correct_folder_id?, note?)`
  — inserts the feedback row via the caller's RLS-scoped client; when a
  folder is chosen it re-routes the email through the SAME `performMove`
  path as a manual drag and stores an **encrypted few-shot
  folder_example** (`source: "feedback"`, idempotent on
  `(folder_id, gmail_message_id)`) so the folder learns from the
  correction. Audited via `rules.feedback_flagged`.

## UI

Settings → Rule activity → expand any row → **"Wrong folder? — move
to…"** dropdown. Selecting a folder fires the whole flow and refreshes
the log.

## Tests

`classification-feedback.test.ts`: ownership rejection on the audit-row
lookup, and the determinism/priority-ranking contract behind the
alternatives list.
