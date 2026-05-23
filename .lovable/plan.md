## Plan

1. **Add swipe-left-to-archive on mobile email rows**
   - In `src/routes/_authenticated/inbox.tsx`, wrap each email list row with a touch-driven swipe handler that only activates on mobile (touch events).
   - As the user drags left, the row translates with their finger and reveals a red Archive background underneath with an icon.
   - Releasing past a threshold (~35% of row width) animates the row off-screen and archives the email; releasing short of the threshold snaps back.

2. **Reuse existing archive flow**
   - Call the same optimistic update + `archiveEmail` server fn already used by the list's context menu Archive item, plus the existing toast.
   - No new server logic, no schema changes.

3. **Keep desktop behavior intact**
   - Tap/click selection, context menu, and hover styles stay unchanged.
   - Swipe only triggers from touch input, so mouse drags on desktop are unaffected.

4. **Verify**
   - On the 402x716 mobile preview, swipe a row left to archive (row slides off, toast appears, list updates).
   - Short swipe snaps back. Tap still opens the email. Context menu still works.

## Technical notes

- Single-file change: `src/routes/_authenticated/inbox.tsx`.
- Implemented with `onTouchStart` / `onTouchMove` / `onTouchEnd` and a small per-row `translateX` state — no new dependencies.
- Vertical scroll is preserved: if the initial movement is more vertical than horizontal, the swipe handler bails out so the list keeps scrolling normally.