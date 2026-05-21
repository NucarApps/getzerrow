## Why the banner looks stuck

Two real bugs, one cosmetic:

1. **The cron job that advances backfills was never scheduled.** The previous migration created `/api/public/gmail-backfill-tick` but no `cron.schedule(...)` row was added for it. Looking at recent activity, only `push` (webhook) and `poll` (gmail-poll) events are firing — no backfill ticks. That's why Tony's job ran exactly **once** (right after sign-up, from the inline kick), pulled the first 1,000 IDs, and then sat at `status=listing, next_page_token=<set>` forever. The `total_found` is stuck at 1,000 because each tick lists 10 pages × 100 = 1,000 IDs and nothing has called it since.

2. **The progress bar shows 0% during the "listing" phase** even when things are healthy. The bar's math is `(total_enqueued − remaining_message_jobs) / total_enqueued`. While we're still discovering IDs, `remaining` ≈ `total_enqueued`, so the bar sits at 0% and looks broken. The user reads "Finding messages… 1,000 so far" with an empty bar and thinks nothing is happening.

3. (Minor) The label "Finding messages from the last 6 months — 1,000 found so far" doesn't communicate that this is a *running count* that will keep climbing.

## Fix

### 1. Schedule the backfill cron (new migration)

Add a `pg_cron` entry that POSTs to `/api/public/gmail-backfill-tick` every minute, using the same `private.cron_post` helper and anon-key auth the other Gmail crons already use:

```sql
select cron.schedule(
  'gmail-backfill-tick',
  '* * * * *',                       -- every minute
  $$ select private.cron_post('/api/public/gmail-backfill-tick'); $$
);
```

Also bump the per-tick budget so a 6-month / multi-thousand mailbox finishes in a reasonable time:

- raise `BACKFILL_LIST_PAGES_PER_TICK` from 10 → 20 (≈2,000 IDs/tick → ~10k mailbox lists in ~5 min)
- have `/api/public/gmail-backfill-tick` accept `?limit=4` (it already does) and pass it from the cron so up to 4 accounts advance per minute.

### 2. Fix the progress UI in `BackfillBanner.tsx`

Make the "listing" phase visually honest instead of showing a stuck 0% bar.

- **Listing phase**: hide the determinate progress bar. Replace it with an indeterminate shimmer/marquee bar plus a live count: *"Scanning your last 6 months — 2,400 messages found so far. We'll start importing as soon as the scan finishes."*
- **Processing phase**: keep the determinate bar (this one is meaningful — `total_enqueued − remaining_jobs / total_enqueued`).
- **Done**: unchanged ("Import finished — N new messages added").
- Also surface an elapsed-time hint after 60s of listing ("Large mailbox — this can take a few minutes") so users don't think it's stuck.

No backend changes needed for #2 — `getBackfillStatus` already returns `status`, `total_found`, `total_enqueued`, and `remaining`.

### 3. Kick Tony's stuck job immediately

Once the cron is scheduled it will pick up the existing `listing` row on the next minute boundary — no manual intervention needed. The `next_page_token` is already persisted, so it resumes where it left off.

## Verification

1. After the migration deploys, watch `backfill_jobs` for Tony's account: `total_found` should climb by ~2,000 every minute and `total_enqueued` should climb in step.
2. `message_jobs` row count for that account should grow, then drain via the existing `gmail-process-jobs` cron.
3. Reload the Inbox — the banner should show an indeterminate shimmer with a growing "X found so far" during listing, then flip to a real percentage bar during processing, then disappear when done.
4. New sign-ups: same behavior end-to-end, no user action required.

## Out of scope

- No change to per-message classification, the webhook path, or the existing "Catch up last 7 days" / "Backfill recent 30" buttons.
- No new secrets — reuses the same anon-key cron auth pattern.

Approve to implement.