## Use the real Zerrow rocket as the player ship

Replace the hand-drawn SVG paths in the Space Invaders mini-game (`TrackingStandby.tsx`) with the uploaded rocket PNG so the player flies the actual Zerrow ship.

### Steps
1. Save `user-uploads://zerrowship.png` to `src/assets/zerrow-ship.png`.
2. In `src/components/inbox/TrackingStandby.tsx`:
   - Import the asset: `import shipUrl from "@/assets/zerrow-ship.png"`.
   - Inside the player `<g>` (lines 629–642), remove the inner `<g transform="scale(0.045)…">` block with the seven `<path>` rocket pieces.
   - Replace with a single SVG `<image href={shipUrl} …>` sized to match the current rocket footprint (~6 game units wide, centered on the player anchor), with `preserveAspectRatio="xMidYMid meet"`.
   - Keep the thruster polygon and the `invuln` class wrapper unchanged so flashing-on-hit and movement flame still work.

### Out of scope
- No gameplay, hitbox, speed, or layout changes.
- Aliens, bullets, and power-ups stay as-is.
