## Goal

Make Settings → **Inbox filters** and **Activity** scoped to a single connected Gmail account so users with multiple inboxes see (and edit) them separately instead of mixed together.

## Approach

Add a Gmail account picker at the top of each of those two tabs (reusing the existing global account-selection context as the default). Every list, count, and write in those tabs is filtered to the picked account.

For the **Activity** tab this is a pure UI/query change — `pubsub_events` already has `email_address` and `message_jobs` / account health already have `gmail_account_id`.

For **Inbox filters** the underlying tables (`inbox_overrides`, `inbox_override_exceptions`) are only scoped per user today, so they need a small schema change to also scope per account.

## Changes

### 1. Schema (migration)

- Add `gmail_account_id uuid` to `public.inbox_overrides` (nullable at first for backfill).
- Backfill existing rows: assign each row to that user's oldest `gmail_accounts.id`. If a user has zero connected accounts, leave NULL (treated as "all accounts").
- Set `NOT NULL` after backfill (skipped when any user still has no account → keep nullable; the UI treats NULL as "applies to all").
- Add index on `(user_id, gmail_account_id)`.
- `inbox_override_exceptions` stays as-is — it's already linked through `override_id`, so scoping flows from the parent.
- Update the sync read in `src/lib/sync/account-context.ts` to filter overrides by `gmail_account_id = <account being processed> OR gmail_account_id IS NULL`.

### 2. Settings page (`src/routes/_authenticated/settings.tsx`)

- Inside the **Inbox filters** and **Activity** tab panels, render an `<AccountPicker />` at the top (single-select dropdown of the user's connected Gmail accounts, defaulting to the global `useAccountSelection().activeAccountId`, falling back to the first account).
- Pass the selected `accountId` (and the account's `email_address`) as props to `InboxOverrides`, `AccountHealthPanel`, `PubsubActivity`, and `ProcessingJobs`.
- If only one account is connected, hide the picker (no behavioral change for single-account users).

### 3. `InboxOverrides` component

- Accept `accountId` + `accountEmail` props.
- Query/insert/delete `inbox_overrides` scoped to the selected account (`.eq("gmail_account_id", accountId)` on read; set `gmail_account_id` on insert).
- Header copy reflects which inbox the list applies to ("Always send to inbox — {email}").

### 4. `AccountHealthPanel`

- Accept `accountId` prop. Filter the rendered rows from `getAccountHealth` to just that account (server fn already returns all; cheapest fix is a client filter, no server change needed).

### 5. `PubsubActivity`

- Accept `accountId` + `accountEmail` props.
- Extend `listPubsubEvents` server fn to accept an optional `account_id` (resolves to `email_address` of that account and filters `pubsub_events.email_address`).
- Extend `getSyncLatencyStats` similarly (currently it aggregates across all of the user's accounts — add optional `account_id`).
- Health/diagnostics panel ("re-arm watch", "last push") becomes specific to the selected account.

### 6. `ProcessingJobs`

- Accept `accountId` prop.
- Extend `listMessageJobs` server fn to accept optional `account_id` and apply `.eq("gmail_account_id", accountId)`.
- Stats (total/pending/running/dlq) come from the same filtered query so they also reflect just that account.

### 7. New shared component

`src/components/settings/AccountPicker.tsx` — small shadcn `Select` listing the user's connected accounts. Used by both tabs.

## Out of scope

- The global account switcher in the inbox header (no change).
- Folder rules, contacts, and other settings (no change — they already either belong globally or are tied to a folder which already has `gmail_account_id`).
- Backend changes to per-account override semantics during sync are limited to the one read in `account-context.ts`; the rest of the sync pipeline already operates per account.
