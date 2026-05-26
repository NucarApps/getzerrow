## Goal

You already connect multiple Gmail accounts in Settings (personal + work both work today), but the app silently picks the first one. This adds a visible account switcher in the sidebar, and scopes the folder list, unread counts, and inbox view to whichever account is active. Switching accounts swaps folders and emails together.

Nothing changes about how mail syncs — both accounts keep filing in the background. This is a UI/scope change only.

## What the user sees

- Top of the left sidebar (above Inbox / Reports / Contacts), a new compact dropdown shows the active account's email with a chevron.
- Clicking it opens a menu listing every connected Gmail account, a checkmark on the active one, and a "+ Connect another Gmail" entry that jumps to Settings (existing connect flow — no changes there).
- Picking an account:
  - persists the choice in `localStorage` (survives reload),
  - swaps the Folders list (only that account's folders appear),
  - swaps the email list (Inbox now shows only that account's mail),
  - resets the selected folder to "All inbox" so you don't land on a folder that belongs to the other account.
- Mobile top bar gets the same dropdown next to the menu icon.
- If only one account is connected, the dropdown still renders as a static label (no menu) so the UI doesn't shift when you add a second.

## Implementation

Frontend-only. No DB changes, no server-fn changes, no sync changes.

### 1. New context: `src/lib/account-selection.tsx`
- Mirrors `folder-selection.tsx`. Exports `AccountSelectionProvider`, `useAccountSelection()` → `{ activeAccountId, setActiveAccountId }`.
- Persists to `localStorage` under `zerrow.activeAccountId`.
- On mount, if the stored id is missing or not in the user's account list, falls back to the first account.

### 2. Wire provider in `src/routes/_authenticated.tsx`
- Wrap `<FolderSelectionProvider>` with `<AccountSelectionProvider>`.
- In `SidebarInner`:
  - Read `accountsQ.data?.accounts` (already fetched via `listMyGmailAccounts`).
  - Replace the hardcoded `accountsQ.data?.accounts[0]?.id` with `activeAccountId` from the context. After accounts load, if `activeAccountId` is `null` or not in the list, set it to `accounts[0].id`.
  - Add an `<AccountSwitcher />` component (new file `src/components/AccountSwitcher.tsx`) rendered just above the nav block. Uses shadcn `DropdownMenu` + `Mail` icon. Shows `accounts.find(a => a.id === activeAccountId)?.email_address`.
  - Menu items: each account (with check + `needs_reauth` warning badge from existing field), divider, "Connect another Gmail" → `navigate({ to: "/settings" })`.
  - When `setActiveAccountId` is called, also call `setSelected("all")` from folder-selection to avoid stale folder selections.
- Folders query already keys on `accountId` — only change is which id flows in.
- Emails count query gets `gmail_account_id` filter: `.eq("gmail_account_id", activeAccountId)`.

### 3. `src/routes/_authenticated/inbox.tsx`
- Replace the local `accountQ` (lines 310–317) with `useAccountSelection()`.
- Add `.eq("gmail_account_id", activeAccountId)` to every `from("emails")` query in this file (operator search, free-text search, paged list). Folder picker already filters by folder which is account-scoped, but emails table isn't, so this is required to keep streams from mixing.
- Include `activeAccountId` in the relevant `useQuery` queryKeys so caches don't bleed across accounts.

### 4. Mobile top bar
- Render `<AccountSwitcher compact />` next to the `<Menu />` button in the mobile header.

### 5. Things explicitly NOT changed
- Contacts, My Card, Reports, Admin: stay user-scoped (not per-account). The user didn't ask for these to switch, and contacts are derived from all mail.
- Settings page already lists all accounts with connect/disconnect — no changes needed there.
- Backfill banner: it already iterates per-account jobs; leave as-is.
- Realtime subscriptions: still per-user; client-side filter on `gmail_account_id` for the active account happens implicitly via React Query refetch.

## Edge cases

- **Zero accounts**: switcher renders "No account connected" with a button that opens Settings. Folder list and inbox show their existing empty states.
- **Account disconnected while active**: on the next accounts refetch, if `activeAccountId` is no longer in the list, the context auto-falls back to `accounts[0]` (or `null`).
- **Folder belongs to the other account**: switching account resets `selectedFolder` to `"all"`, so the user never sees an empty list because of a stale folder pick.

## Files

- new: `src/lib/account-selection.tsx`
- new: `src/components/AccountSwitcher.tsx`
- edited: `src/routes/_authenticated.tsx` (provider + sidebar wiring + mobile bar)
- edited: `src/routes/_authenticated/inbox.tsx` (use context; filter emails queries)
