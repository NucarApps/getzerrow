# Condense the Meetings header on mobile

Right now the Meetings page header stacks everything vertically on mobile: a large icon + title + description, then three full-width buttons ("Record in person", the orange "Record a meeting"), plus the gear — each on its own line. That eats most of the first screen. This plan puts the action buttons on one compact line and tightens the header.

## What changes (mobile)

```text
Before                          After
┌───────────────────────┐       ┌───────────────────────────────┐
│ [icon] Meetings        │       │ [icon] Meetings               │
│        Send a note...  │       │                               │
├───────────────────────┤       │ [🎙 In person] [＋ Record] [⚙] │
│ [ Record in person   ] │       └───────────────────────────────┘
├───────────────────────┤
│ [ Record a meeting   ] │
├───────────────────────┤
│ [⚙]                    │
└───────────────────────┘
```

- The three actions (Record in person, the orange Record a meeting, and the gear) sit on **one horizontal row** of small buttons instead of stacking.
- Buttons become compact (`size="sm"`) on mobile. The gear stays icon-only; "Record in person" shrinks to a mic icon only on the smallest widths, while the orange "Record a meeting" keeps its label as the primary action.
- The header description ("Send a notetaker bot to record…") is hidden on mobile to reclaim vertical space; it stays on larger screens.
- Desktop layout is unchanged (buttons still show full labels in a row).

## Technical details

All edits are in `src/routes/_authenticated/meetings.tsx` (presentation only, no logic changes):

1. **Header container (lines 136–156):**
   - Change the action wrapper from `flex flex-col gap-2 sm:flex-row` to a row that stays horizontal on mobile too, e.g. `flex flex-row flex-wrap items-center gap-2`.
   - Hide the description `<p>` on mobile: add `hidden sm:block`.
   - Optionally reduce the header icon box size on mobile so the row fits.

2. **Trigger buttons inside the dialog components:**
   - `InPersonRecordDialog` trigger (line 502): switch `w-full sm:w-auto` to compact `size="sm"`; wrap the "Record in person" text in a `hidden sm:inline` span so only the mic icon shows on the narrowest screens.
   - `RecordDialog` trigger (line 260, the orange primary): make it `size="sm"` and drop `w-full`, keep the "Record a meeting" label; shorten to "Record" on the smallest width if needed.
   - `MeetingSettingsDrawer` gear (in `src/components/meetings/MeetingSettingsDrawer.tsx`): already `size="icon"`; make it `size="sm"`/icon so it matches the row height.
   - `ScreenRecordDialog` stays desktop-only (already gated by `!isMobile`).

No server functions, data, or behavior change — this is a mobile layout/spacing refinement.