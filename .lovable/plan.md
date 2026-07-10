# Fix: missing upcoming meetings when a calendar account needs reconnecting

## What's wrong

The **Upcoming** tab reads your Google Calendar per connected account. When an account's Google connection has gone stale (its `needs_reconnect` flag is on — currently the case for `shawn@nucar.com`), the app still tries to read that calendar, the read fails, and the error is **caught and silently swallowed**. That account's meetings simply disappear from the list, and because at least one calendar is still "connected," the page shows a misleading "No upcoming meetings…" (or a partial list) with no explanation.

Result: a real meeting (your 9 AM today) that lives on a needs-reconnect account never shows up, and nothing tells you why.

This is not a Recall-vs-us data problem — we never fetch that calendar at all while the account is in the needs-reconnect state.

## The fix

Make the failure visible and actionable instead of hidden.

### 1. Report per-account status from the server (`src/lib/meetings.functions.ts`)
- In `listAllUpcomingCalendarEvents`, distinguish a "needs reconnect" failure from a transient one when a per-account calendar read throws.
- Import `NeedsReconnectError` from `google-oauth.server` and detect it (directly, or via the account's `needs_reconnect` flag which is already selected). 
- Add the account's `needs_reconnect` flag to the `gmail_accounts` select.
- Return an extra field alongside `events`, e.g. `accountsNeedingReconnect: { id, email }[]`, listing every calendar account that couldn't be read because it needs reconnecting. Keep `calendarAccess` and `events` unchanged so nothing else breaks.

### 2. Surface it in the UI (`src/components/meetings/UpcomingMeetingsCard.tsx`)
- When `accountsNeedingReconnect` is non-empty, render a clear, friendly banner above the list: e.g. "Reconnect shawn@nucar.com to see its meetings," with a button/link that points to the existing Settings reconnect flow for Gmail accounts.
- Only show the plain "No upcoming meetings with a Zoom, Meet, or Teams link in the next 14 days." empty state when there are **no** accounts needing reconnect — otherwise the reconnect banner is the message.
- If some accounts loaded and others need reconnect, show both the loaded meetings and the banner.

### 3. Reconnect entry point
Reuse whatever the Settings page already uses to reconnect a Gmail/calendar account (the same OAuth authorize flow). The banner links there (deep-link to settings) rather than duplicating OAuth logic in this card.

## Notes / out of scope
- No database schema change is needed; `needs_reconnect` already exists on `gmail_accounts`.
- Once `shawn@nucar.com` is reconnected, its calendar reads resume and the 9 AM meeting appears normally — the banner is what makes that obvious.
- This does not change how meetings with no supported video link are filtered, or how secondary (non-primary) calendars are read; if a meeting is ever missing for those reasons, that's a separate follow-up we can tackle after confirming this fixes the reported case.

## Technical detail
- `listAllUpcomingCalendarEventsForAccount` currently throws on token failure; the outer loop catches into `meeting_list_all_events_failed`. We'll branch there: if the account row has `needs_reconnect` (or the thrown error is `NeedsReconnectError`), push it to `accountsNeedingReconnect` instead of only logging.
- Type update: extend the query-return type used by `useQuery` in `UpcomingMeetingsCard` to include the new field.
