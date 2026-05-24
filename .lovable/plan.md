## Make swipe-to-archive feel instant

The swipe row in `src/routes/_authenticated/inbox.tsx` (`SwipeRow`, lines 202–259) waits 180ms for a slide-out animation before calling `onArchive()`. That delay is what feels laggy — the row sits on screen after you let go.

### Change

In `SwipeRow.onTouchEnd`, when the swipe passes the threshold:
- Call `onArchive()` immediately (synchronously on touch release), instead of after `setTimeout(..., 180)`.
- The optimistic cache update in `onArchive` already removes the row from the list, so the row disappears instantly — no need to animate the empty row off-screen first.
- Drop the `animating` state path entirely (no longer needed) and reset `dx` to 0.

Also shrink the swipe-commit threshold slightly (from 35% → 25% of row width) so a small flick commits without requiring a long drag.

### Why this is enough

The visible "delay" is the 180ms slide-out, not the server round-trip — the server call is already fire-and-forget with an optimistic update. Removing the animation gate makes archive feel as snappy as the optimistic update allows.

### Files

- `src/routes/_authenticated/inbox.tsx` — edit `SwipeRow` only. No server, schema, or other UI changes.
