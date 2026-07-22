# Rule from example email (rules upgrade, task 11)

Right-click any email → **"Make rule from this email…"** → the AI
proposes a folder name + rule tree + safe actions → the user reviews,
dry-runs it with the task-10 simulator, and approves. Nothing is saved
until approval.

## Server fn (`proposeRuleFromEmail`)

Decrypts the one email (ownership-checked against the caller), sends
sanitizer-wrapped sender/subject/snippet to the gateway inside the
untrusted-email boundary (task-2 hardening), timeboxed with
`AI_CLASSIFY_ATTEMPT_TIMEOUT_MS`. An optional `intent` string (≤500
chars, sanitized) steers the proposal.

## Untrusted-output validation (`src/lib/sync/propose-rule.ts`)

The model's reply is treated as untrusted output:

- strict Zod schema — recursive rule-node shape, name ≤120 chars, leaf
  values ≤500 chars, group fan-out ≤32,
- re-checked with the SAME `validateRuleNode` bounds gate as the save
  path (depth ≤8, leaves ≤128),
- **actions are whitelist-only**: `archive` / `mark_read` / `star`. A
  proposal can never carry a webhook, outbound email, or any action
  that reaches outside the mailbox,
- on ANY violation (or AI timeout/error) the flow falls back to a
  deterministic domain rule built from the example email itself —
  always valid, never AI-derived. (Deviation from the sketch: the
  fallback is deterministic rather than a second AI call — simpler and
  it cannot fail the same way twice.)

## UI

`RuleFromEmailDialog`: editable name, readable rule summary, action
chips, an inline "Preview against last 7 days" (task-10 simulator) and
Create — which creates the folder and applies the tree + flags through
the same RLS-scoped writes the folder dialogs use.

## Tests

`src/lib/sync/propose-rule.test.ts` (11): valid parse incl.
prose-wrapped JSON + action dedupe; rejection of malformed JSON, missing
fields, webhook/outbound action smuggling, bad node shapes, oversized
values, and over-deep trees; deterministic fallback for domain and
domainless senders.
