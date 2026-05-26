## Problem

`TrackingStandby` (the Space Invaders-style standby game in the reading pane) fills 100% of the pane width and uses an SVG with `viewBox="0 0 100 100"` + `preserveAspectRatio="none"`. On wide monitors this stretches the playfield horizontally — the ship, enemies ("emails"), bullets and HUD all get wider with the window.

## Fix

Cap the game's rendered size and stop the SVG from stretching, so it stays a consistent size regardless of how wide the reading pane is.

### `src/components/inbox/TrackingStandby.tsx`

1. Root container (line 526): wrap the playfield in a centered, max-width box so it no longer scales past a sensible size on wide screens.
   - Change root to a flex centering wrapper (`h-full w-full flex items-center justify-center bg-[#02030a] overflow-hidden`).
   - Inside, render the existing playfield in a sized box: `relative h-full w-full max-w-[900px] aspect-[4/3] max-h-full overflow-hidden` (keeps a fixed game aspect; on narrow panes it shrinks naturally, on wide panes it stops at 900px).
   - Move the `ref={containerRef}`, `tabIndex`, key handlers, and all children onto this inner box so input handling and the input-size measurement used by the game logic continue to work.

2. Playfield SVG (line 593): change `preserveAspectRatio="none"` → `preserveAspectRatio="xMidYMid meet"` so the ship, enemies, and bullets keep their proportions instead of being stretched horizontally.

3. Sanity-check the mobile control bar (line 761) and overlays (start screen at line 703) — they're absolutely positioned within the inner playfield box, so they continue to sit correctly.

No changes needed in `inbox.tsx` — the reading pane stays full-width; only the game inside it is constrained.

## Out of scope

- No changes to game logic, scoring, or physics constants.
- No changes to inbox layout or other panes.
- No new dependencies.
