# Backfill the last 7 days of all mail

## Why this works now

You already have `backfillRecent` in `src/lib/sync.server.ts` (line 575). It calls Gmail with the query `-in:chats -in:trash -in:spam newer_than:7d` — so it asks for everything in the last week except chats, trash, and spam, **including mail that was auto-archived past the inbox**. Each message is run through `processGmailMessage` → `processOneMessage`, which (after the fix we just shipped) now persists non-INBOX mail as archived and runs the same filter / domain / AI classification on it.

The two gaps today:

1. The existing UI button "Backfill recent 30" caps at 30 messages (max 100 per the validator) and only fetches one Gmail page.
2. `backfillRecent` itself doesn't paginate — it only reads `list.messages` from the first response.

A real week-long catch-up needs pagination because a busy week can be hundreds or thousands of messages.

## Fix

### 1. `src/lib/sync.server.ts` — add a paginating helper

Add a new exported function `backfillWindow(accountId, userId, opts)` that:

- Accepts `{ query: string; maxMessages?: number; concurrency?: number }`. Default `maxMessages = 1000`, `concurrency = 4`.
- Loops `listMessages(accountId, { q: query, maxResults: 100, pageToken })` until `nextPageToken` is undefined or we've accumulated `maxMessages` IDs.
- De-dupes IDs across pages (Gmail can repeat under load).
- Pre-filters out IDs already in `emails` for this account (one batched `select gmail_message_id from emails where gmail_account_id = $1 and gmail_message_id = any($ids)`) so we don't re-pull and re-classify what we already have. This makes the button safely re-runnable.
- Runs the remaining IDs through `processGmailMessage` with a small concurrency pool (4 at a time) to keep within Gmail's per-user quota and avoid AI-gateway thrash.
- Returns `{ found, alreadyHad, processed, failed, durationMs }`.

Leave `backfillRecent` alone — `triggerSync`'s safety-net path still uses it and 30 messages is fine there.

### 2. `src/lib/gmail.functions.ts` — expose it

Add a new server function:

```ts
export const triggerWeekBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string; days?: number; max?: number }) =>
    z.object({
      account_id: z.string().uuid(),
      days: z.number().int().min(1).max(30).optional(),
      max: z.number().int().min(1).max(2000).optional(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    const days = data.days ?? 7;
    return backfillWindow(data.account_id, context.userId, {
      query: `-in:chats -in:trash -in:spam newer_than:${days}d`,
      maxMessages: data.max ?? 1000,
    });
  });
```

### 3. `src/routes/_authenticated/settings.tsx` — add the button

Next to "Backfill recent 30" on each connected account, add a second button "**Catch up last 7 days**" wired to `triggerWeekBackfill`. Reuse the same busy/toast pattern as the existing backfill button. Toast wording: `Pulled N new messages from the last 7 days (M already in sync).` Disable while running. No other UI changes.

### Run a one-shot for the current account immediately

After the code lands, run the new button once for your account so the Nissan letter (and any other auto-archived mail from this week) backfills. The next plan step (cron) makes this self-healing going forward, but this catches today's gap.

## Out of scope

- No schema changes, no migrations, no new tables. `emails.gmail_message_id` is already unique-by-account via the existing insert path; the de-dupe select is purely a performance/cost optimization.
- No changes to the realtime push/poll/jobs path — that already inserts everything correctly after our last fix.
- No scheduled/cron version yet. The button is a manual catch-up. If you want a recurring nightly "last 24h" sweep as belt-and-braces, that's a tiny follow-up (pg_cron → `triggerWeekBackfill` with `days:1`), worth doing but separate from this change.
- No changes to `backfillRecent`, `triggerSync`, or `triggerBackfill` — keeping the existing 30-message safety net so behavior elsewhere doesn't shift.

## What to watch after running it

- `select count(*) from emails where gmail_account_id = $you and received_at > now() - interval '7 days'` before and after — should jump.
- Your **All mail** folder badge should grow accordingly, with the missing Nissan letter showing up tagged with the **Factory** pill.
- `message_jobs` should stay empty (we're calling the synchronous path, not enqueuing).
- AI Gateway usage: 1000 cap × your classification cost; raise/lower via the `max` param if needed.
