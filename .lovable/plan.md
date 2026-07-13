# Reorganize settings into one grouped Settings hub

Turn `/settings` into a single hub with a left-hand grouped nav, and pull the meeting settings out of the crowded drawer into that hub. Fix the per-account card repetition by adding one account switcher per section instead of stacking a card per connected mailbox.

## Target structure

```text
Settings
├─ EMAIL
│   ├─ Accounts          connected Gmail accounts, sync/backfill
│   ├─ Inbox filters     always-inbox overrides
│   └─ Activity          account health, push activity, processing jobs
├─ MEETINGS
│   ├─ Recording         notetaker bot, auto-record, record blocklist
│   └─ Calendar          calendar guard, calendar selection, event filters, upcoming events
└─ ACCOUNT
    └─ General           delete account (danger zone)
```

A left rail (on desktop) / top select (on mobile) with the three group headings replaces the current flat 3-tab row. Each item is its own route so it's deep-linkable and each panel loads only its own cards.

## Navigation & account handling

- One `Settings` entry in the sidebar (unchanged). It lands on Email › Accounts by default.
- On the Meetings page, the crowded settings drawer (gear icon) is replaced by a "Meeting settings" button that navigates to Settings › Meetings › Recording. The `MeetingSettingsDrawer` component is retired.
- **Per-account repetition fix:** Meeting sections that were rendered once per connected mailbox (auto-record, calendar guard, calendar selection, upcoming events) now show a single account switcher at the top of the section, and only the selected account's cards below it. Reuses the existing `AccountPicker` + shared `useAccountSelection` state (already used by the Email tabs), so the chosen mailbox stays consistent as you move between sections.

## Route files (under `src/routes/_authenticated/`)

- `settings.tsx` → convert to a **layout**: page title + grouped settings nav + `<Outlet />`. No content of its own.
- `settings.index.tsx` → redirect to `/settings/accounts`.
- `settings.accounts.tsx` → Email › Accounts (moves the "Connected Gmail accounts" card + backfill/sync UI out of today's `settings.tsx`).
- `settings.inbox.tsx` → Email › Inbox filters (`InboxOverrides` + account picker).
- `settings.activity.tsx` → Email › Activity (`AccountHealthPanel`, `PubsubActivity`, `ProcessingJobs` + account picker).
- `settings.meetings-recording.tsx` → Meetings › Recording (`MeetingBotCard`, `MeetingAutoRecordCard`, `MeetingRecordBlocklistCard`).
- `settings.meetings-calendar.tsx` → Meetings › Calendar (`CalendarGuardCard`, `MeetingCalendarSelectCard`, `MeetingEventFilterCard`, `MeetingCalendarEventsCard`).
- `settings.account.tsx` → Account › General (the existing `DangerZone`).

All existing setting card components are reused as-is — this is a re-layout, not a rewrite of their logic. Each route keeps `robots: noindex` and gets a section-specific title (e.g. "Meeting recording — Settings — Zerrow").

## New shared component

- `src/components/settings/SettingsNav.tsx` — the grouped nav rail (Email / Meetings / Account headings with items), highlighting the active route via `useRouterState`. Collapses to a `Select` on mobile.

## Meetings page change

- `src/routes/_authenticated/meetings.tsx` — swap `<MeetingSettingsDrawer />` for a `Link`/button to `/settings/meetings-recording`. Remove the now-unused drawer import.

## Technical notes

- Flat dot-named route files; each `createFileRoute("/_authenticated/settings/<name>")` string matches its filename.
- `settings.tsx` becomes a layout whose component returns the nav + `<Outlet />`; the old page body is distributed into the new leaf routes.
- No server-function, schema, or business-logic changes — purely presentation/organization, consistent with the current cards and `useAccountSelection`.
- `MeetingSettingsDrawer.tsx` is deleted after its cards are rehomed.

## Out of scope

Folder rules stay edited in the inbox (via `EditFolderDialog`) since they're per-folder and contextual; I can add a "Manage folders" shortcut from Settings › Email later if you want it centralized too.