# Pub/Sub & auto-classification visibility

## Why

I checked the "SHOP SUPPLIES…" email from `Joe.Belliveau@nissan-usa.com` in the database. Its stored fields say:

- `classified_by`: `domain_rule`
- `classification_reason`: `Domain rule: nissan-usa.com → Factory`
- `raw_labels`: includes the Factory Gmail label, and **does not include INBOX**

That means our code *recorded* that it auto-classified and auto-archived it. But you're telling me you moved it manually in Gmail. Both can't be fully true — one of these is happening:

1. Pub/Sub push didn't fire in time. The 2-minute fallback poll caught it *after* you'd already moved it in Gmail. By then the Factory label was on the message, so our classifier saw a domain rule match and overwrote the reason as "domain_rule" instead of "gmail_label".
2. Pub/Sub fired, we classified correctly, and the UI just hadn't refreshed yet on your side.

Right now there is no log of webhook hits and no way to tell which path ran for a given email, so we're guessing. This plan fixes that.

## What to build

### 1. Log every Pub/Sub webhook hit
- New `pubsub_events` table: `id`, `received_at`, `email_address`, `history_id`, `accounts_matched`, `synced_count`, `error`.
- `src/routes/api/public/gmail-webhook.ts` inserts one row per push, before and after `syncSinceHistory`, capturing counts and any error.
- This makes it instantly obvious whether Google is actually pushing to us.

### 2. Record processing timestamps on each email
- Add `processed_at` column on `emails` (when our sync first inserted the row).
- Show "received → processed" delta on the email detail view so a >2-min gap is visible (= Pub/Sub didn't fire, fallback poll picked it up).

### 3. Fix the "domain_rule overwrites manual move" ambiguity
- In `classifyParsedEmail` (sync.server.ts), check Gmail label match **before** domain/filter rules even when our own folder label is in `raw_labels`. If the label is already on the message at sync time, record `classified_by: gmail_label` with reason "Already labeled in Gmail" instead of re-attributing to a domain rule.
- This is what changes the diagnostic story: if you really did move it first, the row will say so.

### 4. Surface classification source in the inbox UI
- Small badge/tooltip on each row in the email list: "Auto: domain rule" / "Auto: AI" / "From Gmail label" / "Manual move" / "Filter: …".
- Uses the existing `classified_by` + `classification_reason` columns — no new data needed beyond #3.

### 5. Keep the Gmail watch fresh
- `gmail_accounts.watch_expiration` is 2026-05-27 — fine now, but Gmail watches expire every 7 days and a silent expiration is the #1 cause of missing pushes.
- Add a daily cron that calls `ensureWatch` for every account whose `watch_expiration` is within 48 hours, and log results to `pubsub_events` as type `watch_renew`.

### 6. Manual "Resync now" button on the Gmail account
- In settings, a button that calls `syncSinceHistory` on demand, so when you suspect drift you can force a catch-up without waiting for the 2-min cron.

## What's intentionally NOT in scope
- No change to folder rules, AI classifier, auto-archive behavior, or the Factory folder configuration.
- No new Pub/Sub topic / Google Cloud changes — assuming the existing topic is wired up. If `pubsub_events` shows zero pushes for live traffic, that becomes the next task.

## Technical notes
- New migration: `pubsub_events` table + `emails.processed_at` column, both with proper RLS (events table = service-role only, no user select).
- One small edit in `sync.server.ts` (label-match precedence).
- One small edit in `gmail-webhook.ts` (logging).
- One new cron job for watch renewal.
- UI: badge component in the email list row + small section on the email detail.

After this is in, the next time an email feels "stuck", I'll be able to tell you exactly whether Google pushed it, when we processed it, and which rule labeled it — instead of guessing.
