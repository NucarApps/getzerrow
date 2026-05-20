## What's actually happening

The `pubsub_events` table genuinely has **0 rows ever**. The panel is technically correct — it's showing zero activity because Google has never delivered a push to `/api/public/gmail-webhook`. But it feels broken because:

1. The app **is** doing real work every 1-2 minutes (polling, syncing, processing) — none of that is being recorded into `pubsub_events`, so the panel looks dead.
2. The "Last event: never" line, empty table, and silent state make it look like the panel is the bug, when really the GCP push subscription is the bug.

## Plan

Make the panel reflect all sync-related activity (not just push) so the user can see the system is alive, while keeping push vs. poll clearly distinguished.

### 1. Log poll runs to `pubsub_events`

In `src/routes/api/public/gmail-poll.ts`, after the per-account sync loop, insert one row per poll run:
- `event_type: "poll"`
- `email_address`: account email
- `accounts_matched`: number of accounts polled
- `synced_count`: emails enqueued/synced this run
- `error`: any error

Also log a `"watch_rearm_auto"` event when self-heal re-arms a watch.

### 2. Show poll + push distinctly in the panel

In `src/components/settings/PubsubActivity.tsx`:
- Rename header to **"Gmail sync activity"** with subtitle clarifying push vs poll.
- Add a 6th stat tile: **Poll runs (24h)**.
- Add `"poll"` to the filter chips (All / Push / Poll / Errors / Watch renewals).
- Color-code the `Type` badge: push (default), poll (secondary), watch_renew/watch_rearm_auto (outline), error (destructive).
- Update the red banner: only trigger when push24 === 0 **AND** poll24 > 0 (proves polling works, push is the broken half).
- Add a green "polling is working" banner when poll24 > 0 (so the user knows the fallback is keeping mail flowing).

### 3. Surface the real bug clearly

When `push24 === 0 && poll24 === 0` for >30 min, show an amber banner: "Neither push nor poll has fired recently — the cron job may be paused." (Different root cause from the existing "push silent" banner.)

### 4. Don't touch

- The actual GCP Pub/Sub subscription config (out of scope, requires Google Cloud Console).
- `message_jobs` queue, classifier, sync logic.
- Other settings panels.

### Files

- `src/routes/api/public/gmail-poll.ts` — add `pubsub_events` insert per run + per re-arm.
- `src/components/settings/PubsubActivity.tsx` — new stat, new filter, new banners, color-coded badges.
- `src/lib/gmail.functions.ts` — extend `listPubsubEvents` stats to compute `poll24`.

No DB migration needed (`pubsub_events.event_type` is free-form text).