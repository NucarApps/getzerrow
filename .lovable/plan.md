# Fix: emails Gmail auto-archives never enter Zerrow's DB

## Why this email is missing

The Nissan Dealer Communications email exists in your Gmail (with the label `Inbox Zero/Factory`) but is not in Zerrow's database. I checked:

- `gmail_accounts` shows your account is syncing — last poll 2026-05-20 22:36:37 UTC, history_id `144636391`, watch active until May 27.
- `pubsub_events` shows the push for this email did arrive (`history_id 144636370`, `synced_count = 1`).
- `message_jobs` is empty (jobs were processed and cleared).
- `emails` table has **zero** rows matching the Nissan VP letter — `subject ILIKE '%Letter from Nissan Vice President%'` and `from_addr ILIKE '%NissanDealerCommunications%'` both return 0.

The root cause is in `src/lib/sync.server.ts` line 293, inside `processOneMessage`:

```ts
if (!parsed.raw_labels?.includes("INBOX")) return { skipped: true };
```

You almost certainly have a Gmail-side filter (or Gmail itself) that strips `INBOX` from Nissan dealer mail before Zerrow gets a chance to process it. When the pubsub push arrives, Zerrow fetches the message, sees no `INBOX` label, and silently drops it. That's why **every** historical Nissan row in the DB has `is_archived = true` — those were ingested earlier through a different code path (the gmail-label-watch flow in `pullMessagesByLabel` at line ~514, which DOES insert non-INBOX messages as lightweight rows). The realtime path doesn't.

This is exactly the gap the new "All mail" folder is meant to close. Right now "All mail" can only show what's already in the `emails` table, so it can't show messages we never inserted.

## Fix

In `src/lib/sync.server.ts`, change `processOneMessage` so that non-INBOX messages are **inserted as archived** instead of skipped, while still excluding mail classes Zerrow has no business showing.

### Specifics

1. **Replace the hard skip at line 293** with a category filter:

   ```ts
   const labels = parsed.raw_labels ?? [];
   const EXCLUDED = ["SENT", "DRAFT", "TRASH", "SPAM", "CHAT"];
   if (EXCLUDED.some((l) => labels.includes(l))) return { skipped: true };
   const inInbox = labels.includes("INBOX");
   ```

   We keep dropping mail the user clearly didn't "receive in their inbox" sense (sent items, drafts, trash, spam, chat). Everything else gets persisted.

2. **Set `is_archived` on insert based on `inInbox`** so auto-archived mail goes straight to its archived state instead of polluting the unread inbox counter. In the existing `.insert({ … })` at line 300, add `is_archived: !inInbox`. (Today the column defaults to `false`, and we rely on a later branch to flip it.)

3. **Leave classification (filters / domain rules / AI) running for these rows**. This is what makes the Nissan email show up under the Factory folder pill in "All mail" — same labelling pipeline, just without the INBOX gate.

4. **Skip the "auto-archive to Gmail" side-effect** at lines ~362–367 when `!inInbox`. The message is already not in Gmail's inbox; we don't need to call `modifyMessage(removeLabelIds: ["INBOX"])` again. Wrap that block in `if (inInbox && folder.auto_archive) { … }`.

5. **Counters**: in `src/routes/_authenticated.tsx` `counts` memo, the "All inbox" / "No rules" totals already filter by `!e.is_archived`, so newly-ingested archived rows won't inflate those badges. The "All mail" badge correctly shows the full row count. No changes needed there.

### Out of scope

- No DB schema changes; no migration.
- No changes to the gmail-label-watch path (`pullMessagesByLabel`) — it already does the right thing.
- No backfill of historically-missed mail in this change. If you want to pull missing recent messages after the fix lands, you can run "Backfill recent 30" in Settings; we can also add a one-shot wider backfill in a follow-up.
- Folder rule editor, UI, and the email reader are untouched.

## What you should see after this ships

- The Nissan VP letter (and similar Gmail-filter-archived mail) will appear in **All mail**, tagged with the **Factory** label pill, but won't bump the **All inbox** unread count.
- Going forward, anything that lands in your Gmail account — except sent / draft / trash / spam / chat — will be in Zerrow.
