# Meeting detail: right-side drawer with tabs

Turn the meeting detail view from a centered modal into a right-side sliding drawer. The video plays at the top, and the AI summary and transcript live in a tabbed panel below it.

## What changes

All work is in `src/routes/_authenticated/meetings.tsx` — only the `MeetingDetail` component is reworked. The list, record dialog, and all server functions stay untouched. No backend or business-logic changes.

### Layout (top to bottom, inside the drawer)

```text
┌─────────────────────────────┐
│ Title            [status]   │  header
│ platform · date             │
├─────────────────────────────┤
│  ▶  video player            │  (when recording exists)
├─────────────────────────────┤
│  [ Summary ] [ Transcript ] │  tab bar
│                             │
│  active tab content          │
│  (scrolls)                   │
├─────────────────────────────┤
│ Open link          Delete    │  footer
└─────────────────────────────┘
```

- **Summary tab**: participants chips + AI summary text. If the meeting isn't done yet, show the "recording in progress" note with the Refresh status button. If done but no summary, show a short empty state.
- **Transcript tab**: the speaker/text segment list. Empty state when there's no transcript yet.
- **Recording status strip** (found/not found + Refresh recording) stays directly under the video, since it drives the player.

### Drawer mechanics

- Replace `Dialog`/`DialogContent` with `Sheet`/`SheetContent side="right"` (both already in `src/components/ui`).
- On mobile (current viewport) the right sheet takes near-full width; on desktop it's a fixed-width side panel (`w-full sm:max-w-xl`).
- Body is a vertical flex column: fixed header, video + status, then the `Tabs` region that scrolls internally, then a pinned footer.
- `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` from `src/components/ui/tabs`.
- Keep `open={!!id}` / `onClose` wiring; swap `DialogHeader/Title/Description` for `SheetHeader/Title/Description` and `DialogFooter` for a plain footer div.

## Behavior preserved

- All existing effects stay: live status sync for non-terminal meetings, transcript/summary backfill on open, minting the same-origin stream URL, refresh recording, delete, and the open-in-new-tab / download links under the player.
- Polling, query keys, and toasts are unchanged.

## Out of scope

No changes to the meetings list, the record flow, calendar-exclusion settings, or any server function / database schema.
