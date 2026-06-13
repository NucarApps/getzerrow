# Match the read indicator with Gmail (two-way, all folders)

## Goal
When a message is read (or marked unread) directly in Gmail, Zerrow's unread dot should update to match — across every connected account and every folder, not just the most recent inbox messages.

## Why the current behavior falls short
Today inbound read changes only arrive via Gmail push/history events and the 15‑minute reconcile cron. The reconcile re-checks read state on a small window (60 newest inbox rows + a slow tail + 200 archived rows) using one Gmail request per message, so reading an older or folder-filed message in Gmail can stay "unread" in Zerrow for a long time. The app→Gmail direction (marking read in Zerrow) already works.

## Approach: a cheap "unread set" diff
Gmail can return every currently-unread message in one paged list call (`q = is:unread`). Comparing that set against local read flags is far cheaper than per-message label fetches and naturally covers all folders and archived mail.

```text
Gmail:  messages.list q="is:unread"  ->  set of unread message IDs (whole mailbox)

local unread rows NOT in Gmail's set  -> mark read   (is_read = true)
Gmail's set rows that are local-read  -> mark unread (is_read = false)
```

Both directions only touch the small unread sets, never the whole table. Each `is_read` change already flows to the UI through existing realtime, so the dot updates without a refresh.

## What gets built

1. **New helper `syncReadState(accountId)`** (`src/lib/sync/read-state.ts`)
   - Page Gmail `messages.list` with `q = "is:unread -in:chats -in:spam -in:trash"` (cap ~5000 ids) into a `Set`.
   - Fetch local rows for the account where `is_read = false` (id + gmail_message_id only — no decryption); any whose id is not in the set get batched into a `mark read` update.
   - Chunk the Gmail unread ids and query local rows that are `is_read = true` but appear in the set; batch them into a `mark unread` update.
   - Batched `update({ is_read }).in("id", chunk)` calls (chunks of 500). Returns counts for logging.

2. **Wire into the reconcile cron** (`src/routes/api/public/gmail-reconcile.ts`)
   - Call `syncReadState(acc.id)` for each non-reconnect account every tick, so all accounts/folders stay matched within ~15 minutes as a guaranteed backstop. Per-account try/catch + logging, consistent with the existing loop.

3. **On-demand sync when the user is looking** (fast path)
   - New authenticated server function `syncMyReadState` (`src/lib/gmail.functions.ts`) that runs `syncReadState` for the caller's connected account(s).
   - Call it from the inbox (`src/routes/_authenticated/inbox.tsx`) on mount and on `visibilitychange -> visible`, debounced, so returning to the tab quickly reconciles the dots. Failures are silent (the cron remains the backstop).

4. **Keep the existing push/history path** unchanged — it stays the real-time fast path; the diff is the reliable catch-all.

## Scope / non-goals
- Only the read/unread flag is reconciled here. Archive/move/delete drift continues to be handled by the existing reconcile passes.
- No schema changes. No new secrets. Uses the existing service-role Gmail helpers and realtime.

## Verification
- Read a message in Gmail (recent, old, and one filed in a folder) → confirm the dot clears in Zerrow after the on-demand trigger (tab focus) and independently via a manual reconcile run.
- Mark a read message unread in Gmail → confirm the dot returns.
- Repeat with a second connected account to confirm all-accounts coverage.
- Add a unit test for the diff logic (pure set comparison producing the two id lists).
