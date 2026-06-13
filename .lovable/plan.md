# Fix: domain set to "always inbox" still files mail into Orders on other accounts

## What happened

- Lynne's email `lynne@manueldesantaren.com` arrived on the **chris@dagesse.com** account and AI-filed it into **Orders** (confidence 0.9).
- Your "always show in inbox" rule for `manueldesantaren.com` exists, but it is **tied to a single account** — **chris@nucar.com** — not to all your inboxes.

## Why

Inbox-override rules can be stored either as "all accounts" (no account attached) or "one account only". The path that created your `manueldesantaren.com` rule (Move to inbox → keep domain in inbox) saved it **attached to the account the original email came from** (chris@nucar.com).

When mail routing runs, it only loads overrides that are either global or belong to the receiving account. Lynne's email came in on chris@dagesse.com, so the chris@nucar.com-scoped rule was invisible to it, and the AI classifier sent it to Orders.

You have three connected inboxes (chris@dagesse.com, chanelldagesse@gmail.com, chris@nucar.com), so any account-scoped override silently fails to protect the other two.

## The fix

Make inbox overrides apply across **all** of your accounts — which is what the unique rule already implies (one rule per user + type + value, account not included).

1. **Save new overrides globally.** In `addInboxOverride` and in the `add_override` branch of the move-to-inbox handler (`src/lib/gmail.functions.ts`), store the rule with **no account attached** (`gmail_account_id: null`) so it covers every inbox. If a matching account-scoped row already exists, promote it to global.

2. **Promote existing rules (data migration).** Set `gmail_account_id = NULL` for all existing `inbox_overrides` rows so every current rule now applies to every account. This is safe because the table already only allows one rule per (user, type, value).

3. **Bring misfiled past mail back.** Reprocess emails that match an existing override but are sitting in a folder on any account — move them out of the folder, restore the INBOX label locally and in Gmail. This reuses the existing reprocess-past logic (already user-wide, not account-scoped) and will pull Lynne's Orders email (and any siblings) back into the inbox.

## Verify

- After the migration, confirm `manueldesantaren.com` override has no account attached.
- Confirm Lynne's email (`lynne@manueldesantaren.com`, currently in Orders) is back in the inbox with `classified_by = inbox_override`.
- Send/simulate a new message from the domain to chris@dagesse.com and chanelldagesse@gmail.com → it stays in the inbox, not Orders.
- Existing "keep in inbox" rules for other domains continue to work and now span all accounts.

## Technical detail

- Account routing reads overrides via `or(gmail_account_id.eq.<accountId>,gmail_account_id.is.null)` in `src/lib/sync/account-context.ts`; account-scoped rows are the gap. Moving to global (`null`) closes it.
- Migration: `UPDATE public.inbox_overrides SET gmail_account_id = NULL WHERE gmail_account_id IS NOT NULL;`
- Reprocess: invoke the existing reprocess-past routine (the loop currently inside `addInboxOverride` that re-files matching emails to inbox via `modifyMessage`) for each affected override, or run it as a one-off backfill for this user. No schema change beyond the migration above.
- After writes, bust the per-account context cache with `invalidateAccountContextForUser` so routing picks up the promoted overrides immediately.
