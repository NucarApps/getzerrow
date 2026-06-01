## Problem

Emails that are currently in your **Gmail inbox** — because you un-snoozed them or manually moved them out of a label/folder back into the inbox — are not appearing in your Zerrow inbox.

## Root cause

Zerrow's "Inbox" view only shows local rows where `raw_labels` contains `INBOX` **and** `is_archived = false`. Two things keep these emails stuck:

1. **The on-demand reconcile only works one way.** `reconcileInboxFromGmail` looks at rows that are *already* in Zerrow's inbox and removes the ones Gmail has since archived. It never does the reverse — it never pulls messages that ARE in Gmail's inbox but are marked archived (or missing the `INBOX` label) locally. So a snoozed-then-returned email, or one you dragged back into the inbox in Gmail, stays flagged as archived in Zerrow forever.

2. **The cron safety-net only scans the 200 newest archived rows.** Older drifted messages (a snooze that fired weeks later, an old thread you re-filed) fall outside that window and never get repaired.

The history-sync path *should* catch the `labelsAdded: INBOX` event live, but if the push/poll was down past Gmail's ~1-week history TTL, or the event paged past the cap, the event is lost and nothing brings the message back.

## Fix

Make the inbox reconcile **bidirectional** by adding an "incoming" pass to `reconcileInboxFromGmail` (`src/lib/gmail.functions.ts`):

```text
existing pass (outgoing):  local-inbox rows no longer in Gmail INBOX  → archive/delete locally
new pass (incoming):       Gmail INBOX messages not visible in Zerrow → restore locally
```

The new pass will:
1. Pull the current Gmail `INBOX` message-id slice (reusing the `listMessages({ labelIds: ["INBOX"] })` call already made in the function — no extra Gmail quota).
2. Look up which of those ids exist locally for the account.
3. For ids that exist locally but are `is_archived = true` or missing `INBOX` in `raw_labels`: fetch their current labels, then update the row to `is_archived = false` and merge `INBOX` into `raw_labels` (and clear stale snooze state). This makes them reappear instantly via the existing realtime subscription.
4. For ids that exist in Gmail's inbox but have **no** local row at all: enqueue them through the normal `message_jobs` ingestion pipeline (the same mechanism `searchGmailAndIngest` uses) so they get parsed, classified, and inserted.
5. Keep the existing per-call repair cap (e.g. 25) so a large divergence can't hammer the Gmail API; the return value will report `restored` / `ingested` counts alongside the current `reconciled` / `deleted`.

The inbox page already calls this function on mount and every 45s and invalidates the email query when it reports changes, so once the counts include the new `restored`/`ingested` numbers, the recovered emails will surface automatically with no UI change required.

## Files touched

- `src/lib/gmail.functions.ts` — extend `reconcileInboxFromGmail` with the incoming pass.
- `src/routes/_authenticated/inbox.tsx` — minor: include the new `restored`/`ingested` counts in the condition that triggers a query refetch.

## Verification

- Reproduce with a known message: confirm a message present in Gmail's inbox but archived locally flips to visible after a reconcile tick.
- Confirm the per-call cap and rate-limit handling still hold.
- Run existing sync tests; type-check clean.

## Notes / limits

- Like the current logic, the incoming pass is bounded to Gmail's most recent 500 inbox messages per call; very old returned-to-inbox mail beyond that window is recovered incrementally by the cron reconcile (which I can also widen if you want a one-time full sweep).
- No schema changes. No change to encryption, RLS, or the webhook/cron auth.
