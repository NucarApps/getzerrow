
## What's actually wrong

Two separate problems, plus one manual step outside the app.

### 1. The "keeps telling me to reconnect" loop — root cause
I traced the real Google response for the affected inbox (`chris@nucar.com`). The account already has calendar access granted correctly (the OAuth token's scope list includes `calendar.readonly`), but the **Google Calendar API is not enabled in your Google Cloud project** (`160989993810`). Every calendar request returns:

```text
403 — "Google Calendar API has not been used in project 160989993810
before or it is disabled. Enable it by visiting console... then retry."
```

The app's sync code currently treats **every** 401/403 as "no calendar access → reconnect Google," so it sends you in a loop that reconnecting can never fix.

**Manual step (only you can do this — one time):** Enable the Google Calendar API for your OAuth project at:
`https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=160989993810`
Then wait a few minutes for it to propagate. After that, "Sync now" will work.

### 2. Can't tell which inbox each card belongs to
The "Calendar cold-email guard" card never shows the account email, so with multiple connected inboxes every card looks identical.

## The plan

**A. Label each card with its inbox (UI only)**
- In `CalendarGuardCard`, show the account email in the header (e.g. as a subtitle under the title), so each connected inbox's card is clearly identifiable.

**B. Stop the misleading reconnect loop + show the real reason**
- In `calendar.server.ts`, parse Google's error `reason` from the 403 body and carry it on `CalendarApiError` (e.g. `accessNotConfigured`/`SERVICE_DISABLED` vs `ACCESS_TOKEN_SCOPE_INSUFFICIENT`/401 vs quota/`rateLimitExceeded`).
- In `calendar.functions.ts` (`syncCalendarNow` and `setCalendarGuard`), return distinct outcomes instead of collapsing everything to `no_calendar_access`:
  - genuine auth/scope failure → `reason: "reconnect"`
  - Calendar API disabled → `reason: "api_disabled"` (with Google's message)
  - rate-limited / transient → `reason: "rate_limited"`
- Persist the last sync error on the account so the card can display it, and clear it on a successful sync. (Small migration: add a `calendar_sync_error text` column to `gmail_accounts`, with the usual grants/RLS already covering the table.) `getCalendarGuardStatus` returns this so the UI can render it.

**C. Card messaging based on the real state**
- Access granted but API disabled → show an informational note ("Google Calendar API isn't enabled for this connection yet — this is a one-time setup in Google Cloud") rather than a "Reconnect Google" button.
- Genuine auth/scope problem → keep the existing "Reconnect Google" prompt.
- Rate-limited/transient → "Try again in a few minutes."
- Show the stored last-error text and last-synced time so the state is never ambiguous.

## Technical notes
- No changes to the OAuth scopes, encryption RPCs, classifier, or sync pipeline — the scope grant is already correct.
- The only schema change is one nullable text column on `gmail_accounts`; `calendar_contacts` and the cron tick are unchanged.
- Tests: extend the existing calendar tests to cover the new error-reason mapping (api_disabled vs reconnect vs rate_limited).

## After you enable the Calendar API
Once the API is enabled in project `160989993810`, toggling the guard on (or clicking "Sync now") will populate your met-contacts and pin those senders to the inbox as designed — no reconnect required.
