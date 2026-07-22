# Reply / Draft / Send-email actions (rules upgrade, task 8)

Folders can now respond to routed mail: auto-reply, prepare a Gmail
draft, or send a fresh notification email — with plain-text templates,
optional delay, and an AI fallback for template-less replies.

## Data model

No new tables or columns — the task-4 `folder_actions` schema already
reserved `subject_template`, `body_template_enc`, `to_addr`, `cc_addr`,
`bcc_addr`. Migration `20260722030000_outbound_action_templates.sql`
adds the SECURITY DEFINER accessor pair (mirroring the task-5 webhook
pair, both service-role only):

- `set_folder_action_template(action, user, subject, body, to, key)` —
  encrypts the body with `private.encrypt_text` + `EMAIL_ENC_KEY` and
  rejects bodies > 4000 chars / subjects > 500 chars in SQL as a
  defense-in-depth backstop.
- `get_folder_action_outbound(action, key)` — decrypts for the runner.

Templates are the ONLY stored copy of outbound content, and they are
stored encrypted. Rendered bodies and AI-drafted replies are sent
straight to Gmail and never persisted (audit rows carry action config
only).

## Templating (`src/lib/sync/action-templates.ts`)

Whitelist-only tokens: `{{from_name}}`, `{{first_name}}`,
`{{subject}}`, `{{received_at:short}}`, `{{first_line}}`. Unknown
tokens stay literal (no arbitrary field access); missing data falls
back (`there`, `(no subject)`, …); input and output are hard-capped at
4000 chars and each token value at 300, with a non-backtracking
replacement pass (ReDoS/DoS invariant).

## Execution flow

1. **Classify time** — `dispatchFolderActions` always **enqueues**
   reply/draft/send_email into `scheduled_actions` (network I/O never
   blocks the rules-first hot path). `delay_minutes = 0` means "next
   runner tick" (≤ 1 minute); `send_email` without `to_addr` is
   rejected up front. The outcome lands in `executed_actions` as
   `pending`, same as webhooks.
2. **Runner** (`run-scheduled-actions`, every minute) — decrypts the
   config, renders the template against the email, then:
   - `reply` → `sendMessage` threaded onto the original
     (`In-Reply-To`/`References` + `threadId`). If no template is
     configured, falls back to the AI drafter (`suggestReply`), raced
     against `AI_CLASSIFY_ATTEMPT_TIMEOUT_MS` (AI-timeboxed invariant).
   - `draft` → `createDraft` (never sends; no AI fallback — a draft
     with no template fails terminally).
   - `send_email` → `sendMessage` to the configured `to_addr` with the
     rendered subject (falls back to `Re: <subject>`).
   Failures retry with the existing backoff ladder; config-gone cases
   fail terminally.

## Tests

`src/lib/sync/outbound-actions.test.ts` (11): token rendering +
fallbacks + unknown-token literalness + output cap, enqueue-with-delay,
send_email recipient validation, and runner paths for all three types
including the AI fallback and terminal failures.

## Deviation from the sketch

The sketch said a zero-delay reply "sends immediately"; it sends on the
next runner tick (≤60 s) instead, keeping all outbound I/O out of the
classify path — the same design the webhook action shipped with.
