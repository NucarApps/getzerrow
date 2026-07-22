# Rule simulator (rules upgrade, task 10)

Dry-run a draft folder + filter set against recent mail before saving —
see exactly which emails would move, which the exclude rules would
veto, and how many stay untouched. Nothing moves.

## Core (`src/lib/sync/simulate-rule.ts`)

Pure and deterministic: overlays the draft onto the account's real
config (editing an existing folder replaces its row + filter set; a
new draft is appended) and runs the SAME `matchByFilters` engine the
classify path uses — priority ordering, filter trees, exclude vetoes
and `sender_in_group` all behave identically. **No AI anywhere in the
loop** — the simulator answers only what deterministic rules would do,
which keeps it fast (<300ms for 1k emails, enforced by test) and free.
Returned lists are capped at 200 rows; counts always cover everything.

## Server fn (`simulateRule`)

`simulateRule({ account_id, folder_id?, days: 1|7|30, draft, filters })`
— auth-gated, with the same bounds gates as the save path:
`validateRuleNode` on the draft tree, ≤50 flat filters with ≤500-char
values, and the email window capped at 1000 (newest first). Email IDs
come from the caller's RLS-scoped client, so the admin decrypt only
ever touches their own mail. Sender groups come from
`loadAccountContext`, so `sender_in_group` rules simulate correctly.

## UI

Folder editor → Rules tab → **"Preview against last 7 days"**: runs the
CURRENT draft state (including an unsaved rule tree) and opens a
results dialog — would-move list with the first matching leaf per
email, veto list, and the untouched count.

## Tests

`src/lib/sync/simulate-rule.test.ts` (6): determinism, already-filed
skipping, exclude vetoes, edit-replaces-config overlay, priority
competition against existing folders, list capping, and the 1k-email
<300ms performance contract.
