## What I found

- Re-arming is working: Gmail accepted a new watch for `chris@nucar.com` and returned a fresh `history_id`.
- Real Gmail Pub/Sub pushes are not arriving after the watch is armed.
- The only recent “push” rows are from the app’s own **Send test request to webhook** button. That button posts an empty `{ message: {} }` payload, so it creates confusing `push_empty` / `push accounts_matched=0` rows even though Google did not send them.
- New emails are still being picked up by fallback polling every ~2 minutes, which means the Gmail account/history sync works; the broken piece is between Google Cloud Pub/Sub subscription delivery and this app’s webhook URL.

## Plan

1. **Stop fake webhook tests from looking like real pushes**
   - Change the webhook/self-test flow so synthetic app-generated tests are logged as `webhook_test`, not `push` or `push_empty`.
   - Fix the current double-log behavior where an empty test request creates both `push_empty` and a final `push` row.

2. **Make diagnostics explicitly compare “watch armed” vs “real push delivered”**
   - In the Gmail sync activity panel, show a clear status when the latest `watch_renew` is newer than the latest real Gmail push.
   - Message should say: the Gmail watch is armed, but the Pub/Sub subscription is not delivering to this app.
   - Keep polling visible as fallback, but label it as fallback rather than treating it as proof push works.

3. **Add a real-payload webhook verifier for app-side processing only**
   - Add a “Test webhook with connected account payload” action that sends a valid Pub/Sub-shaped payload for `chris@nucar.com` to the local webhook.
   - This proves the webhook can decode `emailAddress`, match the account, and call `syncSinceHistory`.
   - Label it clearly as an app-side test, not proof that Google Cloud subscription delivery is configured.

4. **Improve the checklist to show the actual external fix needed**
   - Update the checklist to emphasize that the Google Cloud push subscription must POST to the current webhook URL:
     `https://getzerrow.com/api/public/gmail-webhook` or the current preview URL if testing preview.
   - Show that the topic and subscription must be in the same Google project as `projects/projectinboxzero-495314/topics/gmail-push`.
   - Keep the publisher permission reminder for `gmail-api-push@system.gserviceaccount.com`.

5. **Validate after changes**
   - Check the latest `pubsub_events` rows to confirm synthetic tests no longer pollute real push diagnostics.
   - Re-arm, send a real email, and confirm the panel shows either a fresh real `push` row or a precise “subscription not delivering” status.