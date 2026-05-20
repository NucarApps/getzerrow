## Sync messages that skip the inbox

### Root cause
- `setupWatch` in `src/lib/gmail.server.ts` line 141 calls Gmail with `labelIds: ["INBOX"], labelFilterAction: "include"`. The push channel only fires for changes to INBOX.
- `backfillRecent` in `src/lib/sync.server.ts` line 549 calls `listMessages(..., { q: "in:inbox" })`.

When the user has a Gmail filter that applies a folder label (e.g. `Label_458` = Cold Email) **and** skips inbox, the message never touches INBOX → no watch notification → no sync → invisible to the app.

`braund_erik@officeonkatmai.help`'s message today is exactly that case.

### Fix

**1. `src/lib/gmail.server.ts` → `setupWatch`**
Drop the INBOX filter — watch the full mailbox:

```ts
body: JSON.stringify({ topicName })   // no labelIds, no labelFilterAction
```

Gmail will then deliver `messagesAdded` and `labelsAdded` events for any change in the mailbox, including filter-auto-labeled mail that skipped inbox.

**2. `src/lib/sync.server.ts` → `backfillRecent`**
Broaden the bootstrap query so the first-run pull picks up filter-routed mail too:

```ts
const list = await listMessages(accountId, {
  maxResults,
  q: "-in:chats -in:trash -in:spam newer_than:7d",
});
```

Drops the `in:inbox` constraint; excludes chats/trash/spam to avoid noise. `newer_than:7d` caps backfill volume on first connect.

**3. Re-arm the existing user's watch**
The current account's watch is registered against INBOX only. Existing watch expires 2026-05-26; we shouldn't wait. Add a one-time re-arm:

- After deploy, call `setupWatch` for `chris@nucar.com` (account `adb85c80-…`) via the existing `triggerSync` path or a small admin server-fn invocation. Simplest: clear `history_id` and `watch_expiration` to force the next `triggerSync` to re-bootstrap with the new (broader) watch.

I'll do this through a one-shot SQL update after the code change ships, so the next sync re-registers the watch.

**4. Catch up the missed message**
After step 3, call `backfillRecent` (built-in path runs when `history_id` is null) — it will pull all mail from the last 7 days, including the missing `braund_erik@officeonkatmai.help` message, and run it through the classifier.

### Volume / safety

- Gmail watch on the whole mailbox typically fires a few times per minute for active users. The existing `processGmailMessage` already deduplicates by `gmail_message_id` and is idempotent. No new tables or queues needed.
- The classifier in its current state correctly handles non-INBOX mail (it sets `is_archived = !raw_labels.includes("INBOX")` — see line 717), so the inbox view stays clean. Newly-synced filter-routed mail will appear under its folder, not in "All Inbox".

### Out of scope

- No change to the UI search (already global from the last fix).
- No reconfiguration of the user's Gmail filters.
- No realtime backfill across all historical mail — only last 7 days on rebootstrap. Older filter-skipped mail stays missing unless the user clicks reprocess manually.
- No notification/badge for newly-synced non-inbox mail.
