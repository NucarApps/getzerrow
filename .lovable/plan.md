# Move meeting settings into a slide-out drawer on the Meetings page

Right now all the meeting-related settings live inside the **Settings → Accounts** tab, mixed in with Gmail account management. This moves them onto the Meetings page behind a gear icon that opens a drawer sliding in from the right.

## What changes for the user

- A **gear icon button** appears in the Meetings page header (next to the record buttons).
- Clicking it opens a **drawer that slides out from the right** containing all meeting settings.
- The same settings are **removed from the Settings page**, so there's one clear home for them.

## The settings being moved

These five cards move together (they currently sit in Settings → Accounts):

1. Meeting bot / notetaker card (`MeetingBotCard`)
2. Calendar access guard, one per connected inbox (`CalendarGuardCard`)
3. Auto-record toggle, one per connected inbox (`MeetingAutoRecordCard`)
4. Don't-record blocklist (`MeetingRecordBlocklistCard`)
5. Upcoming meetings / notetaker exclusions, one per connected inbox (`MeetingCalendarEventsCard`)

## Implementation

### New component `src/components/meetings/MeetingSettingsDrawer.tsx`
- A `Sheet` with `side="right"` (same pattern as the existing meeting detail drawer), triggered by a gear (`Settings` icon) `Button`.
- Fetches the connected inboxes with `listMyGmailAccounts` via `useServerFn` + `useQuery` (`queryKey: ["gmail-accounts"]`, matching the existing key so cache is shared).
- Renders the five cards inside a scrollable body, mapping the per-account cards over the fetched accounts, with a clear "Meeting settings" header and short description.

### `src/routes/_authenticated/meetings.tsx`
- Add `<MeetingSettingsDrawer />` into the header action row (alongside the record buttons), rendered as a gear icon button.

### `src/routes/_authenticated/settings.tsx`
- Remove the five meeting cards and their imports from the Accounts tab. Leave `DangerZone`, Gmail account management, and all other tabs untouched.

## Notes
- No backend/server-function changes — same components and data, relocated.
- Verify with a typecheck and a quick browser check that the gear opens the drawer and the cards render.
