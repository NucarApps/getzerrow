## Goal

Make new Gmail messages flow through the pipeline you already have — Pub/Sub push → `message_jobs` queue → rules applied (folder routing, auto-archive, auto-mark-read) — without manual triggering, with polling as a safety net.

## What's already built (no code changes needed)

- `POST /api/public/gmail-webhook?token=<GMAIL_WEBHOOK_TOKEN>` — receives Google Pub/Sub push, enqueues `message_jobs`, and inline-drains a small batch so new mail lands immediately.
- `POST /api/public/gmail-process-jobs` — worker that drains the `message_jobs` queue (this is where folder rules / auto-archive / auto-mark-read are applied).
- `POST /api/public/gmail-poll` — polling fallback; also self-heals the Gmail watch when push has been silent >6h.
- `POST /api/public/gmail-renew-watches` — renews any Gmail watch within 48h of expiring (Gmail watches expire after 7 days).
- All four require `Authorization: Bearer <CRON_SECRET>`.
- `CRON_SECRET`, `GMAIL_WEBHOOK_TOKEN`, `GMAIL_PUBSUB_TOPIC` are already configured as secrets.

## What this plan adds

### 1. Schedule the pg_cron jobs (one migration)

Store `CRON_SECRET` once in a private table inside Postgres (cron can't read project env vars), then schedule four jobs that POST to the stable preview URL with the bearer token.

```text
private.cron_settings        (locked down, service-role only)
  name = 'cron_secret'       value = <CRON_SECRET>
  name = 'base_url'          value = https://project--9ca78824-…lovable.app

cron jobs:
  gmail-process-jobs   */1 * * * *   → /api/public/gmail-process-jobs (every minute, drains queue, applies rules)
  gmail-poll           */2 * * * *   → /api/public/gmail-poll        (every 2 min, fallback + self-heal)
  gmail-renew-watches  0 */6 * * *   → /api/public/gmail-renew-watches (every 6h, keeps push alive)
  run-folder-summaries */5 * * * *   → /api/public/hooks/run-folder-summaries (only if you want the scheduled summaries feature; can be dropped)
```

The migration will need you to paste the `CRON_SECRET` value once so it lands in `private.cron_settings`.

### 2. Confirm/finish the Google Pub/Sub push subscription (you do this in GCP, no code)

So that "new email in Gmail" actually fires the webhook in real time:

1. In Google Cloud Console → Pub/Sub → the topic referenced by `GMAIL_PUBSUB_TOPIC`.
2. Create (or edit) a **push** subscription with:
   - Endpoint URL: `https://project--9ca78824-55f5-4897-b74d-b5b1d219918a.lovable.app/api/public/gmail-webhook?token=<GMAIL_WEBHOOK_TOKEN>`
   - Ack deadline: 60s
   - Retry: exponential backoff
3. Grant `roles/pubsub.publisher` on the topic to `gmail-api-push@system.gserviceaccount.com` (Gmail's service account) — required for Gmail to publish into the topic.
4. Reconnect (or re-run "Start watch" from Settings) on each connected Gmail account so `ensureWatch` registers against the topic.

Once steps 1–4 are in place, push will deliver within seconds of a new Gmail arrival; the cron schedule is the belt-and-suspenders fallback.

## Result

- New Gmail message → Pub/Sub push → webhook enqueues + inline-drains job → folder rules / auto-archive / auto-mark-read applied → row appears in `emails` and inbox UI updates via realtime, all within seconds.
- If push is ever silent (network blip, expired watch), the 2-minute poll catches up and re-arms the watch automatically.
- Watches never expire (renewed every 6h, well inside the 7-day Gmail limit).

## What I need from you to proceed

1. Confirm you want the four cron jobs above (or tell me which to skip — e.g. drop `run-folder-summaries` if you're not using scheduled summaries).
2. Confirm the base URL to use for cron: stable preview (`project--9ca78824-…-dev.lovable.app`), stable published (`project--9ca78824-…lovable.app`), or your custom domain (`getzerrow.com`). Published / custom domain is recommended so cron survives preview rebuilds.
3. You'll paste the `CRON_SECRET` value when the migration runs (so it can be stored in `private.cron_settings`).

I'll handle the Pub/Sub steps as a checklist after the cron is in — they happen in your GCP console, not in code.