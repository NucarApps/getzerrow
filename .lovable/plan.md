# Fix tracking view + show trajectory and angle clearly

## Root cause

The overlay child div uses class `tracking` AND the state added to the viewport is also `tracking`. The CSS rule `.tracking { position: absolute; inset: 0; opacity: 0 }` therefore also matches the viewport element once the state flips on — collapsing the whole panel to `opacity: 0`. That's why the screenshot is empty.

## Fixes

### 1. Rename the state class (no collision)
- `useMissionTelemetry.ts`: change `viewportEl?.classList.add("tracking")` → `add("is-tracking")`.
- `zerrow-landing.css`: every `.launchpad__viewport.tracking …` selector becomes `.launchpad__viewport.is-tracking …`. The inner overlay div keeps class `tracking` (block class only, no state collision).

### 2. Tie activation to actual rocket exit
Bump the timeout from 1.6s to 1.8s (the rocket transform takes 1.6s plus a small buffer so the panel only swaps once the rocket has truly cleared the top).

### 3. Make the trajectory clearly readable (`public/zerrow-landing.css` tracking block)
- Widen the arc stroke (2 → 3px) and brighten the live gradient so it reads against the deep-space background.
- Increase the ghost arc opacity (.18 → .35) and make its dashes longer (4 6 → 6 8) so the full predicted path is obvious from frame 1.
- Add tick marks along the arc (small perpendicular notches every ~20% of length) so the user can read progression at a glance.
- Pin a permanent "current position" rocket marker at the live head of the arc (separate from the looping flyby icon) so even when the loop resets, the trajectory still reads as occupied.

### 4. Show the rocket's angle / heading
Add a third HUD overlay (top-right of the viewport):
- `ANGLE` row showing live pitch in degrees, computed from the tangent of the trajectory curve at the current `offset-distance`. Simpler approach: drive it from a JS angle that ramps from 90° (straight up) → ~25° (downrange) over the same 14s arc cycle. Write to `#t-pitch`.
- A small circular "attitude indicator" SVG (artificial horizon style): a circle with a rotating internal line that matches the pitch — purely visual, CSS-rotated by the same pitch value via a CSS variable on the HUD container.

### 5. Earth horizon polish
Reduce the earth sphere size (1800px → 1100px) and raise it slightly (`bottom: -900px`) so the curve is visible at the bottom of the panel instead of being mostly off-screen.

## Verification
After edits, navigate the browser to `/`, wait ~12 seconds (8s burndown + 1.8s liftoff + buffer), screenshot the launchpad panel, and confirm: dark space background, stars visible, earth curve at bottom, ghost arc + live arc + flying rocket icon, HUDs (tracking badge, downrange/apogee, angle/attitude indicator) all readable.

## Out of scope
Pre-launch animation, telemetry math beyond the new pitch readout, and any non-visual changes.
