# Tracking view after liftoff

Once the rocket clears the launchpad viewport, swap the launchpad scene for a downrange tracking view inside the same `.launchpad__viewport` panel. Telemetry stays live (it already updates after liftoff) and gains a few tracking-only readouts.

## Trigger

In `src/components/landing/useMissionTelemetry.ts`, ~1.6s after `setPhase("liftoff")` (matches the existing 1.6s liftoff transform), add a `tracking` class to the `.launchpad__viewport` element. CSS handles the rest of the scene swap. Clear the timeout in the cleanup.

## DOM additions (`src/routes/index.tsx`, inside `.launchpad__viewport`)

Add a sibling block `.tracking` next to the existing smoke / sparks / rocket-wrap. It contains:

- `.tracking__sky` — deep-space gradient background with faint star dots.
- `.tracking__earth` — curved earth horizon arc anchored to the bottom of the viewport (CSS radial / large circle clipped at bottom).
- `.tracking__arc` — inline SVG with a single dashed/glowing trajectory path arcing from lower-left up across to upper-right. A second solid path layered on top is clip-revealed left→right via `stroke-dasharray` animation so the trajectory "draws" as the rocket flies it.
- `.tracking__icon` — a small SVG rocket (reuse the same arrowhead silhouette, scaled to ~28px) that moves along the arc using CSS `offset-path` set to the same cubic-bezier curve, with `offset-rotate: auto` so it tilts naturally along the tangent. Animation loops slowly (e.g. 14s) so the rocket appears to continually progress downrange.
- `.tracking__hud` — two small corner overlays:
  - top-left badge: `TRACKING · DOWNRANGE` with a blinking dot.
  - bottom-right mini readout: `DOWNRANGE` (km) and `APOGEE` (km), driven by the existing telemetry interval (new IDs `t-downrange`, `t-apogee`).
- Keep the existing `.viewport-telemetry` and `.viewport-counter` panels visible (they already show altitude/velocity/etc), but reposition slightly if they overlap the arc — handled in CSS.

The existing `.smoke`, `.sparks`, `.rocket-wrap`, `.viewport-crosshair`, and `.viewport-grid` are hidden via CSS when `.launchpad__viewport.tracking` is set, with a short fade.

## CSS (`public/zerrow-landing.css`)

New section near the existing viewport rules:

- `.launchpad__viewport.tracking` — adds the deep-space background gradient (dark navy → near-black) and triggers child reveal transitions.
- `.tracking` block hidden by default (`opacity: 0; pointer-events: none`), fades in over ~600ms when parent has `.tracking`.
- `.tracking__sky` — radial subtle vignette + a few `::before/::after` pseudo-elements or small `<i>` star dots with gentle twinkle keyframes.
- `.tracking__earth` — large circle (e.g. 1600px) positioned so only the top sliver shows at the bottom of the viewport, with a soft blue atmospheric glow above the rim.
- `.tracking__arc svg` — absolutely positioned to fill the viewport; trajectory path styled with thin orange dashed stroke + a brighter solid stroke animated via `stroke-dasharray` / `stroke-dashoffset` keyframes (draws across, then resets).
- `.tracking__icon` — uses `offset-path: path("…same curve…")` with `offset-distance` keyframed 0% → 100% and `offset-rotate: auto`. Drop shadow + small flame trail (a short tapered orange streak behind the icon using a pseudo-element).
- `.tracking__hud` overlays: small badges using the existing telemetry typography tokens.
- Hide pre-launch elements when tracking is active:
  `.tracking ~ .rocket-wrap`, `.smoke`, `.sparks`, `.viewport-crosshair` → opacity 0.

## Telemetry tie-in (`useMissionTelemetry.ts`)

Inside the existing post-launch branch of `updateTelemetry`:

- Compute `downrange = vel * elapsedSinceLaunch / 1000` (rough km) and `apogee = max(alt seen)`.
- Write to new `#t-downrange` and `#t-apogee` text nodes if present.

## Out of scope

- No new routes, no backend, no libraries — pure SVG/CSS + the existing RAF.
- Pre-launch scene (rocket, smoke, flame, launchpad base) is untouched.
- Mobile scaling: reuse the existing `@media` rules; the tracking view simply inherits viewport size.
