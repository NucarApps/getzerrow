# Digest action (rules upgrade, task 9)

Folders can collect routed mail into one daily or weekly summary email
instead of interrupting — configured per folder via a `digest` action
row (`digest_bucket`: `daily` default, or `weekly`).

## Data model

Migration `20260722040000_digest_action.sql`:

- `digest_items(id, user_id, email_id → emails ON DELETE CASCADE,
  bucket daily|weekly, sent_at, created_at)` with a partial index on
  pending rows and owner RLS (`USING`/`WITH CHECK auth.uid()`).
  Reference rows only — no email content is duplicated, so nothing new
  needs encryption.
- `user_settings(user_id PK, digest_hour default 8, digest_timezone
  default 'UTC' (≤64 chars), digest_weekly_dow default 1/Monday)` —
  created minimally since no settings table existed; owner RLS.
- Hourly cron `send-digest-hourly` (minute 7) posting to
  `/api/public/hooks/send-digest` via `private.cron_post`.

## Flow

1. **Classify time** — the `digest` action inserts one `digest_items`
   row (bucket from config). Cheap DB write, runs inline; the outcome
   lands in `executed_actions` with the bucket as its payload.
2. **Hourly sender** (`src/lib/sync/digest.server.ts`) — for each user
   with pending rows (50 users/tick cap): loads their settings
   (defaults above; an invalid timezone falls back to UTC), and when
   the local hour matches `digest_hour` sends the daily bucket —
   weekly additionally requires the local weekday to match. Per due
   bucket (100 items cap): decrypts subjects/senders through the
   existing reader, groups by folder, and emails the user's own
   mailbox via `sendMessage`, then stamps `sent_at` on exactly the
   included rows. Per-user failures are isolated.

## AI summary

The 2–3 sentence overview at the top is optional garnish: the listing
fed to the gateway is built from sanitizer-wrapped subjects/senders
(prompt-injection hardening), the call is timeboxed with
`AI_CLASSIFY_ATTEMPT_TIMEOUT_MS`, and any failure falls back to the
plain grouped listing — the digest always sends.

## Tests

`src/lib/sync/digest-actions.test.ts` (6): dispatch row insert with
bucket, local-hour + weekday gating, invalid-timezone fallback, the
full send flow (grouping, recipient, `sent_at` stamping of exactly the
pending rows), quiet off-hours, and the AI-failure fallback.
