## What's actually happening

The DB shows the email **was** moved successfully:

- `rberns@nbminc.com — "Copier Leases"` is in **Cold Email** (`folder_id = b1efc962…`).
- But `classified_by = gmail_label` (not `manual_move`), with reason `Matched Gmail label "Cold Email"`. That means this email was already labeled Cold Email by Gmail at the time it first synced — your manual move in the app then re-applied the same label, which is a no-op.

So the move did run on the server. The reason **you still see the row in your Inbox view** is purely a frontend semantics issue:

- The sidebar's "Inbox" item is wired to `selectedFolder = "all"`.
- The `"all"` query is `is_archived = false` — i.e. every non-archived email, **including ones already filed into a folder**.
- After a manual move, the row's `folder_id` changes but `is_archived` stays `false`, so it keeps showing up in "Inbox".

This matches what you're seeing: the move worked in the database, but the row never leaves your Inbox list.

There's also a small secondary issue: the optimistic cache update flips `folder_id` in place but doesn't remove the row from the current view's array, so even on the strictest filter the row only disappears after the refetch.

## Plan

Make moving an email to a folder in the app behave like Gmail's "Move to label" — it should leave the Inbox view.

1. **Server: archive on manual move (`src/lib/gmail.functions.ts → performMove`)**
   - When moving to a folder, also set `is_archived = true` in `emails`.
   - In the Gmail sync call, add `INBOX` to `removeLabels` alongside the existing label swap, so Gmail's inbox stays in sync.
   - Skip both when the target folder already has `auto_archive = true` (already covered downstream) — so we don't double-write.
   - Same change for `moveEmailToInbox`: when moving back to inbox, set `is_archived = false` and add `INBOX` back as a Gmail label.

2. **Client: optimistic state matches (`src/routes/_authenticated/index.tsx`)**
   - In the two move-to-folder click handlers (inbox row context menu around line 374, and the detail-pane `moveTo` around line 602), include `is_archived: true` in the optimistic `setQueriesData` patch so the row immediately leaves the "Inbox" (`is_archived=false`) view.
   - In the move-to-inbox handler (line 350), include `is_archived: false`.
   - Keep the existing `invalidateQueries({ queryKey: ["emails"] })` so the row's final state matches the server.

3. **Fix the Robert Berns row retroactively**
   - One-off update via migration: set `is_archived = true` for the three rows currently sitting in Cold Email but still flagged `is_archived = false` for this user (or just for this specific message). I'll scope it tightly so it only touches emails that are already in a folder and were never archived.

No schema or RLS changes. No new dependencies.

## Out of scope (call out, don't change)

- The `classified_by` for Robert Berns stays `gmail_label` — that's accurate, the email arrived with the label already. If you want manual moves in the app to always overwrite to `manual_move` even when the row already sits in the right folder, that's a separate decision.
- Renaming "Inbox" sidebar item to mean "Unsorted" — not doing that; you already have a separate Unsorted entry and the Gmail-style "everything not archived" Inbox is the more familiar default.
