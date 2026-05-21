## Why Factory emails are all showing as read

I checked the database. Every email in Factory arrives with these Gmail labels:
`{Label_347, CATEGORY_PERSONAL, Label_5898701622091638806}` — **no `UNREAD`, no `INBOX`**.

That means a **Gmail filter on your account** (almost certainly the same filter that's applying the Factory label and skipping the inbox) is also checking "Mark as read". So by the time Zerrow ingests the message, Gmail itself already considers it read.

Zerrow's `auto_mark_read=false` setting on the folder is being honored — our code only strips `UNREAD` when that flag is true (`sync.server.ts:365`). But Zerrow currently *mirrors* whatever read-state Gmail reports, so a pre-read message comes in already read.

## Two ways to fix it

### Option A (recommended) — Zerrow overrides Gmail's read state for that folder

When a folder has `auto_mark_read = false`, treat every newly-ingested message as **unread in Zerrow**, regardless of Gmail's `UNREAD` label. Opening the email in Zerrow still marks it read in both places (existing behavior at `inbox.tsx:664`).

Trade-off: Zerrow and Gmail's read counts diverge for that folder until you open the message. This matches what you asked for ("I set it to not mark as read").

### Option B — fix it at the source

Edit the Gmail filter that routes Factory mail and uncheck "Mark as read". Zerrow needs no changes. Cleanest semantically, but requires you to go into Gmail Settings → Filters.

---

## Plan for Option A (one file, ~15 lines)

**`src/lib/sync.server.ts`**

1. In `processGmailMessage` (around line 301), after we have `parsed` and before insert, look up the folder this message will land in (we already do this inside `classifyParsedEmail`). Simpler: do the override **after** classification, inside the existing `if (folder_id)` block at line 355 — we already load the folder there with `auto_mark_read`. Add:

   ```ts
   if (!folder.auto_mark_read && !inserted_is_read_from_gmail_is_already_true_only_flip_to_unread) {
     await supabaseAdmin.from("emails").update({ is_read: false }).eq("id", inserted.id);
   }
   ```

   Cleaner shape:

   ```ts
   if (!folder.auto_mark_read) {
     // Honor the folder setting even if a Gmail filter pre-marked it read.
     await supabaseAdmin.from("emails").update({ is_read: false }).eq("id", inserted.id);
   }
   ```

2. In `reconcileAccount` (lines 1040 and 1081), don't blindly mirror `UNREAD` removal for emails whose folder has `auto_mark_read = false`. Otherwise the next reconcile pass would re-flip them back to read. Add a small per-row check: if `row.folder_id` belongs to a folder with `auto_mark_read=false`, skip setting `is_read = true` (only allow `is_read = false`).

   Implementation: fetch a small `Map<folderId, auto_mark_read>` once per `reconcileAccount` call, then guard the two `patch.is_read = ...` lines.

3. **Backfill the existing 179 rows in Factory:** one-time SQL via migration to set `is_read = false` on every email currently in Factory.

   ```sql
   UPDATE emails
   SET is_read = false
   WHERE folder_id = '3384a10d-1e0b-4b1a-942a-d064ddbc9df3';
   ```

   (Or generalize: any folder where `auto_mark_read=false`.)

No frontend changes. No Gmail API writes — we deliberately do not strip Gmail's read-state, because the user's Gmail filter wants them read in Gmail.

---

## Which option do you want?

If you want **Option A**, I'll implement it. If you'd rather fix the Gmail filter (**Option B**), no code change is needed — just edit the filter in Gmail Settings.