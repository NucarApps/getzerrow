# Split meetings into Past and Upcoming tabs

Right now the Meetings page stacks the "Upcoming meetings" card on top of the list of recorded (past) meetings. This change separates them into two tabs.

## What changes

Only `src/routes/_authenticated/meetings.tsx` (frontend/presentation only — no backend, data, or server-function changes).

- Add a `Tabs` block below the page header with two triggers, in this order:
  - **Past meetings** — the existing list of recorded meetings (loading / empty state / meeting rows), currently rendered inline.
  - **Upcoming** — the existing `UpcomingMeetingsCard`, moved out of its current always-visible spot above the list.
- Default the active tab to **Past meetings**.
- Keep the header (title, Record buttons) and the `MeetingDetail` sheet exactly as they are, outside the tabs.

```text
Meetings                        [Record in person] [Record a meeting]

[ Past meetings ] [ Upcoming ]
------------------------------------------------
(selected tab content)
```

## Technical notes

- `Tabs, TabsList, TabsTrigger, TabsContent` are already imported, so no new imports are needed.
- Move the `<UpcomingMeetingsCard />` (currently in the `mb-6` wrapper) into the Upcoming `TabsContent`.
- Move the existing `meetingsQ.isLoading ? … : meetings.length === 0 ? … : (list)` block into the Past `TabsContent`.
- Copy stays sentence case ("Past meetings", "Upcoming") per brand voice.
