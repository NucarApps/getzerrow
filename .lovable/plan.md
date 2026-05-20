
# Found it — GCP push endpoint is the wrong URL

No code change needed. The fix is one field in Google Cloud.

## What's wrong

Your subscription's **Push endpoint** is set to:

```
https://getzerrow.lovable.app/api/public/gmail-webhook
```

I just POSTed a sample Pub/Sub envelope to both URLs:

| URL | Response |
|---|---|
| `https://getzerrow.lovable.app/api/public/gmail-webhook` | **HTTP 302** (redirect) |
| `https://getzerrow.com/api/public/gmail-webhook` | **HTTP 200 `ok`** |

`getzerrow.lovable.app` is redirecting to your custom domain. **Google Cloud Pub/Sub push subscriptions do not follow 3xx redirects** — anything other than 2xx is treated as a delivery failure, with no record in `pubsub_events` because the POST never reaches our handler. That's exactly the symptom you're seeing: watch armed, polling fills the gap, zero `push` rows ever.

The topic, permissions (`gmail-api-push@system.gserviceaccount.com` ✅), and subscription state (`active`, Push, auth disabled) are all correct. Only the endpoint URL is wrong.

## Fix (in Google Cloud Console)

1. Pub/Sub → Subscriptions → `gmail-push` → **Edit**
2. Change **Push endpoint** to:
   ```
   https://getzerrow.com/api/public/gmail-webhook
   ```
3. Save.

Within ~30s you should see `push` rows in the Pub/Sub Activity panel and the red "Watch is armed, but no real Google push has arrived" banner clear.

## Optional follow-up (code, after the fix verifies)

If you want, I can:

- Update the diagnostic banner in `PubsubActivity.tsx` to actively probe the configured push URL on the server and warn if it returns a redirect instead of 200 — so future domain swaps surface this within the app instead of requiring a GCP console trip.

Tell me whether to add that probe; otherwise the GCP edit alone fixes today's issue.
