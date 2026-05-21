## Two things are broken, not one

### 1. The poll fallback also stopped — `cron_secret` is missing from the DB

`pg_cron` runs `private.cron_post('/api/public/gmail-poll')` every 2 min. That function reads the cron secret from `private.cron_settings`:

```sql
SELECT value INTO v_secret FROM private.cron_settings WHERE name = 'cron_secret';
IF v_secret IS NULL OR v_base IS NULL THEN
  RAISE NOTICE 'cron_post: missing cron_secret or base_url';
  RETURN NULL;   -- never calls the endpoint
END IF;
```

Right now that table only has `base_url`. There is no `cron_secret` row:

```
name      | length
----------|--------
base_url  | 29
```

That's why the `poll` rows in `pubsub_events` stopped exactly at **01:02** and never resumed — the cron job fires, the function early-returns, no HTTP call is made. Cron itself is healthy (latest `cron.job_run_details` are all `succeeded` at 02:30) because `RAISE NOTICE` + `RETURN NULL` is a successful execution from Postgres' POV.

This is separate from your Pub/Sub edit — it suggests the `cron_secret` row was either dropped, never re-seeded, or got out of sync with the Lovable Cloud `CRON_SECRET` secret.

### 2. Pub/Sub pushes — most likely cause: nothing to push since 02:24

The Gmail watch was re-armed at **02:24:04** (`watch_renew` event). Gmail only sends a Pub/Sub push when your mailbox actually changes after the watch starts — new mail, label changes, reads, etc. If no inbound mail has hit `chris@nucar.com` since 02:24, **zero pushes is the expected outcome**, regardless of whether the token is correct.

We can't tell from the logs whether your new `?token=…` value matches `GMAIL_WEBHOOK_TOKEN`, because the webhook rejects unauthorized POSTs with a bare 401 *before* it writes to `pubsub_events` (see `src/routes/api/public/gmail-webhook.ts` lines 19–25). So failed pushes leave no trace.

The webhook test you ran at 02:23 (`webhook_test`, synced 1) does **not** validate the real token — it sets `x-zerrow-test: 1`, which bypasses the token check entirely. So a green test ≠ Pub/Sub will be accepted.

## Plan

### Step A — re-seed the cron secret (fixes the poll fallback immediately)

Apply a migration that upserts the current `CRON_SECRET` into `private.cron_settings` so `private.cron_post` starts firing again:

```sql
INSERT INTO private.cron_settings (name, value)
VALUES ('cron_secret', current_setting('app.cron_secret'))
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;
```

Since `app.cron_secret` isn't a real GUC, the actual migration will inline the secret value from Lovable Cloud secrets — I'll write the migration as `INSERT … VALUES ('cron_secret', '<value>') ON CONFLICT DO UPDATE` and pull `<value>` from `CRON_SECRET` at the time it's applied. After that, the very next 2-minute tick should produce a fresh `poll` row in `pubsub_events`.

### Step B — make Pub/Sub push failures observable (so the next debug round takes 30 seconds)

Patch `src/routes/api/public/gmail-webhook.ts` so unauthorized requests log a single diagnostic row to `pubsub_events` before returning 401:

- `event_type = 'push_unauthorized'`
- `subscription` = the URL the caller hit (so we see which Pub/Sub subscription is misconfigured)
- `details` = `"Token missing"` / `"Token mismatch (provided length X, expected length Y)"` — never logs the secret value itself, just lengths and a 4-char fingerprint so we can compare without leaking.

Then we tell you: send yourself a test email to `chris@nucar.com`. Within ~30 s, either:
- a real `push` row appears (everything is fixed), **or**
- a `push_unauthorized` row appears with details that pinpoint the mismatch (wrong token, wrong subscription, etc.).

### Step C — also surface this in Settings → Activity

The `PubsubActivity` panel already renders rows from `pubsub_events`; once `push_unauthorized` rows exist they'll show up there automatically with their `details`. No UI change required for step C — it's a side effect of step B.

## Files touched

- New migration: `supabase/migrations/<ts>_reseed_cron_secret.sql` — upserts the cron_secret row.
- `src/routes/api/public/gmail-webhook.ts` — ~10 line addition to log unauthorized attempts before returning 401, with token-length / fingerprint diagnostics (no secret values logged).

No changes to: client, RLS policies, cron schedule, watch logic, or scopes.

## Out of scope

- Adding a "test real Pub/Sub round-trip" button (would need to publish to your topic, which requires GCP credentials in the app — not worth it).
- Reworking how `CRON_SECRET` is kept in sync between Lovable Cloud secrets and `private.cron_settings`. Worth doing later as a trigger-based sync, but for now a one-shot reseed gets you unblocked.

## What I need from you after I ship A + B

1. After the migration applies, watch `pubsub_events` for a fresh `poll` row within 2 minutes — confirms the polling fallback is back.
2. Send yourself an email at `chris@nucar.com`. Within ~30 s, check Settings → Activity (or `pubsub_events`). Tell me what shows up:
   - `push` row with `synced_count > 0` → fully fixed.
   - `push_unauthorized` row → paste me the `details` field and I'll point at the exact field that's wrong in your Pub/Sub config.
   - Nothing at all → the Pub/Sub subscription's push endpoint URL or the topic itself is misconfigured on the Google side; I'll walk you through where to look.
