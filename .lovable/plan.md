## Goal
Show all connected Gmail accounts per user in the admin table, not just the first one.

## Changes

**`src/lib/admin.functions.ts`**
- Change `AdminUser.gmail` from a single object to `gmail_accounts: Array<{...}>` (same fields as today, plus keep `last_poll_at`, `last_push_at`, `watch_expiration`, `has_history_id`).
- Replace the "first gmail account wins" map with a `Map<string, GmailAccountInfo[]>` so every row from `gmail_accounts` is included.
- Sort each user's accounts by `email_address` for stable display.

**`src/routes/_authenticated/admin.tsx` (`UserRow`)**
- Render each connected Gmail address on its own line in the "Gmail" column (stacked `<div>` per account, with the Mail icon).
- In the "Last sync" column, show one line per account with its own last_push/last_poll timestamp and stale indicator (>24h).
- If the user has zero accounts, keep the existing "—" fallback.
- If they have 2+, show a small "×N" badge next to the user email so it's scannable.

## Out of scope
- No schema changes (already supports many gmail_accounts per user).
- No changes to stats aggregation (stats remain per-user, which is correct).
- No changes to filtering/sorting of the user list.