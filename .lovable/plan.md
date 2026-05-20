## Problem

On a folder like **Factory** (linked to a Gmail label), clicking **Next page** past the locally-loaded emails calls `loadOlderFromLabel` and reports "No older emails found in Gmail" — even though many older messages exist in that label.

## Root cause

`loadOlderFromLabel` (`src/lib/sync.server.ts:771`) decides how to fetch the next batch from Gmail based on a stored `gmail_backfill_page_token` + `gmail_backfill_oldest_received_at`:

```ts
if (beforeReceivedAt <= folder.gmail_backfill_oldest_received_at && pageToken) {
  pageToken = folder.gmail_backfill_page_token;
}
```

If that condition fails — which is the normal case the first time a user paginates, or whenever the locally-known emails are newer than the last backfill checkpoint — we fall through with **no `pageToken` and no date filter**, so `listMessages({ labelIds: [...], maxResults: 50 })` returns the **newest 50 messages in the label**. Those are exactly the ones we already have, so `ingested = 0`, `claimed = 0`, and the UI shows "No older emails found in Gmail."

There is no fallback that uses the caller-provided `beforeReceivedAt` as a Gmail search anchor, so we never actually ask Gmail for older messages.

## Fix

When we don't have a usable `pageToken`, fall back to a Gmail search query anchored to `beforeReceivedAt` so we always retrieve messages older than the local cursor.

### Change in `src/lib/sync.server.ts` (`loadOlderFromLabel`)

Replace the listMessages call (~lines 792–807) with:

```ts
let pageToken: string | undefined;
let q: string | undefined;

const tokenUsable =
  beforeReceivedAt &&
  folder.gmail_backfill_oldest_received_at &&
  new Date(beforeReceivedAt).getTime() <=
    new Date(folder.gmail_backfill_oldest_received_at).getTime() &&
  folder.gmail_backfill_page_token;

if (tokenUsable) {
  pageToken = folder.gmail_backfill_page_token!;
} else if (beforeReceivedAt) {
  // Anchor to the local cursor so Gmail returns messages older than what
  // we already have. Gmail's `before:` operator takes a unix-seconds value.
  const secs = Math.floor(new Date(beforeReceivedAt).getTime() / 1000);
  q = `before:${secs}`;
}

const list = await listMessages(folder.gmail_account_id, {
  labelIds: [folder.gmail_label_id],
  maxResults: 50,
  pageToken,
  q,
});
```

`listMessages` already supports `q` (see `src/lib/gmail.server.ts`), so no API helper changes are needed.

### Optional defensive tweak

After processing, if `ingested === 0 && claimed === 0` AND we took the `pageToken` path AND `list.nextPageToken` exists, the stored token is stale. Clear it (`gmail_backfill_page_token: null`) so the next click falls through to the date-anchored query. Small change in the same `update({...})` block at the bottom.

## Not changing

- The "No rules" / All-inbox views (those don't call `loadOlderFromLabel`).
- The pagination state machine in `_authenticated/index.tsx` — `pullOlderMut` already passes `pageRows[last].received_at` as `before_received_at`.
- No schema migrations; we already store the columns we need.

## Verification

1. Open **Factory**, paginate past page 2 to trigger the pull.
2. Confirm the toast now says "Pulled N older email(s) from Gmail." and the next page renders.
3. Repeat — each click should keep walking deeper via the new `before:` cursor anchored to the last visible row.
