# Fix "duplicate key" error when keeping mail in the inbox

## What's happening

When you pick **Inbox — always show** for a sender/domain, the app saves an "always keep in inbox" rule. For `manueldesantaren.com` it crashed with:

```text
duplicate key value violates unique constraint
"inbox_overrides_user_id_match_type_value_key"
```

## Why

The "always-inbox" rules table (`inbox_overrides`) enforces uniqueness on **(user, match type, value)** — it does **not** include which Gmail account the rule belongs to.

But the save code first checks "does this rule already exist?" while *also* filtering by Gmail account. Your existing `manueldesantaren.com` rule is tied to a specific Gmail account, while the save screen creates a rule with **no account** (applies to all accounts). So:

1. The "already exists?" check looks for an account-less rule → finds nothing.
2. It then tries to insert → the database rejects it because a rule with the same user + type + value already exists (just on a different account).

In short: the existence check and the database's uniqueness rule disagree on whether the account matters, so an already-existing rule slips past the check and the insert blows up.

## The fix

Make the save operation idempotent and aligned with the actual uniqueness rule, in `addInboxOverride` (`src/lib/gmail.functions.ts`):

- Change the "already exists?" check to match on **(user, match type, value)** only — drop the `gmail_account_id` filter — so an existing rule (account-scoped or global) is correctly detected as already present.
- When it already exists, skip the insert and return `already: true`, so the UI shows **"Already on the inbox list"** instead of crashing.
- As a safety net, switch the insert to an upsert that ignores conflicts on the `(user_id, match_type, value)` constraint, so a race or edge case can never surface a raw database error again.

No schema/migration change is needed — we're conforming the code to the existing constraint.

## Verify

- Re-run the exact flow from the screenshot (Domain → `manueldesantaren.com` → Inbox — always show) → expect a friendly "Already on the inbox list" toast, no error.
- Add a brand-new domain the same way → expect "Future mail kept in inbox".
- Confirm routing still works: account-scoped and global overrides are both still honored (no behavior change to how mail is kept in the inbox).

## Technical detail

The mismatch is between `inbox_overrides_user_id_match_type_value_key UNIQUE (user_id, match_type, value)` and the existence query in `addInboxOverride`, which adds `.eq("gmail_account_id", …)` / `.is("gmail_account_id", null)`. Removing that account predicate from the pre-check (and using `upsert(..., { onConflict: "user_id,match_type,value", ignoreDuplicates: true })`) resolves it without touching the reprocess-past logic.
