# Why your new email isn't in Pub/Sub activity

I checked the database and here's what actually happened with your "Test 2" email:

- **Email arrived in Gmail:** 18:13:48
- **It DID get synced into the app at 18:16:00**, but via the **2-minute poll fallback** — not via a Google push.
- The last (and only) push event we've ever received was at **18:12:05**, and even that one had `email_address = NULL` and `accounts_matched = 0` — meaning Google's Pub/Sub message did not contain a usable payload, so we couldn't match it to your account.

So the user-visible symptom ("it's not in pub/sub activity") is real and correct: **Google is not pushing notifications for new messages on this account.** Polling is the only thing keeping the inbox up to date right now, which is why you see a ~2 minute delay.

## Root-cause hypotheses (in order of likelihood)

1. **Pub/Sub topic / subscription mis-wired.** The Gmail watch we re-arm points at the topic in `GMAIL_PUBSUB_TOPIC`, but the push subscription on that topic may not point at `https://getzerrow.com/api/public/gmail-webhook` (or the dev URL). Symptom matches exactly: watch is "alive" (expires 5/27) but pushes never reach us.
2. **Watch is registered against the wrong topic / different Google project** than the one whose subscription targets our webhook. Same symptom.
3. **Subscription is paused or has an ack-deadline / dead-letter problem** in GCP, so Google stops re-delivering after the one bad push at 18:12.
4. **Webhook is rejecting the body** — ruled out, our handler always returns 200 and we have a `push_empty` row proving Google reached us once.

## Plan

### 1. Make push diagnosable from the app (no GCP console needed)

- Extend `pubsub_events` logging in `src/routes/api/public/gmail-webhook.ts` to also store:
  - raw `message.messageId` and `message.publishTime` from the Pub/Sub envelope
  - the decoded payload as JSON (so we can see when `emailAddress` is missing)
  - the `subscription` field GCP includes on every push
- In `src/components/settings/PubsubActivity.tsx`, add a **"Last push details"** expandable row showing those fields for the most recent `push` / `push_empty` event. This immediately tells you whether the push that arrived was malformed vs not arriving at all.

### 2. Surface the right diagnosis banner

Right now the panel shows generic banners. Replace with one of:
- **Red — "Google is not pushing for your account"**: shown when `last push > 10 min ago` AND polling has synced ≥1 message in that window. Includes a one-click **"Re-arm watch"** button (already wired) and a copy-to-clipboard of the **exact webhook URL** the GCP push subscription should target.
- **Amber — "Push received but payload didn't match your account"**: shown when most recent push has `accounts_matched = 0`. Tells the user the watch was probably created against a different Google project / topic than the subscription forwarding to us.
- **Green — "Push is healthy"**: when a `push` event with `accounts_matched ≥ 1` arrived in the last 10 minutes.

### 3. Re-arm with stricter verification

In `renewGmailWatch` (server fn), after calling `users.watch`:
- Log the `topicName` and `historyId` that Google returned into a new `gmail_watch_log` table (or just into `pubsub_events` as `event_type = 'watch_rearm'` with the topic embedded in `error`/a new `details` column).
- Surface that topic name in the activity panel so it's obvious whether watch and subscription are on the same topic.

### 4. (Optional, do not touch yet) GCP-side checklist for the user

Add a small collapsible **"Pub/Sub setup checklist"** in the panel listing:
- Topic name must equal `GMAIL_PUBSUB_TOPIC` (we'll display the current value)
- A push subscription on that topic must POST to the webhook URL we display
- `gmail-api-push@system.gserviceaccount.com` must have `roles/pubsub.publisher` on the topic
- Subscription must not be paused and ack deadline ≥ 10s

No code is changed for #4 beyond rendering static text — it just gives you a one-screen verification.

## Files to touch

- `src/routes/api/public/gmail-webhook.ts` — richer logging
- `src/lib/gmail.functions.ts` — extend `listPubsubEvents` return shape, expose `lastPush`, `lastPushPayload`, `webhookUrl`, `pubsubTopic`
- `src/components/settings/PubsubActivity.tsx` — new banners, "Last push details" row, checklist
- `supabase/migrations/*.sql` — add `payload jsonb`, `message_id text`, `publish_time timestamptz`, `subscription text` columns to `pubsub_events`

## Out of scope

- Anything inside Google Cloud Console — we'll give you the values to check, but won't (and can't) edit the subscription.
- Changing how polling works. Polling is already covering for push and successfully synced your "Test 2".
- Folder / classifier / job worker changes.

## What you'll see after this lands

Within 1 next push (or the next time you click "Send test push"):
- A red banner saying *"Google delivered a push but `emailAddress` was missing — your watch is probably on a different topic than the subscription forwarding to us. Topic the watch returned: `projects/.../topics/X`. Webhook URL the subscription should target: `https://getzerrow.com/api/public/gmail-webhook`."*
- Or, if pushes still don't arrive at all: an amber banner saying *"No push received in 12 min, polling synced 3 messages in that window — the subscription almost certainly isn't pointed at our webhook."*

Either way you'll know in one glance which knob to turn in GCP.