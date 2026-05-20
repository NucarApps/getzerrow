## Goal

Replace the current cartoony rocket SVG on the landing page with a sleek low-poly rocket matching the uploaded reference image (sharp orange triangular body, three flared fins, dark center seam), and polish the liftoff sequence so the flame ignites first, then the smoke billows out as the rocket rises.

## Reference vs current

- **Reference**: tall isosceles-triangle orange rocket, dark vertical center crease, two side fins flared outward + one center fin, bright white→yellow→orange tapered flame, voluminous puffy cloud of smoke at the base with sparks.
- **Current**: white capsule with windows, "ZERROW" label, orange triangular fins, thin flame, six small blurry smoke puffs.

## Changes

### 1. Rocket SVG — `src/routes/index.tsx` (lines ~155–176)

Replace the entire `<svg className="rocket">` block with a new low-poly rocket built from a few flat polygons:
- Large orange triangle body (`#ff6b3d`) with a darker orange right half (`#c94a22`) to create the lit/shadow crease down the middle.
- Dark navy center seam triangle (`#0a0e1a`) at the base of the body for the nozzle recess.
- Three angular fins: two side fins (orange + darker orange shadow face) flared outward at the base, plus a small dark center fin behind the nozzle.
- No windows, no text label, no rivets — keep it iconic and graphic like the reference.
- Slightly taller viewBox (e.g. `0 0 120 240`) so proportions match the reference.

### 2. Exhaust flame — `public/zerrow-landing.css` (`.exhaust`, `.exhaust__core`, `.exhaust__halo`)

- Widen the plume slightly (≈48px) and lengthen it (≈160px) so it reads as a real thrust column under the nozzle.
- Brighten the core gradient: white → pale yellow → orange → transparent, with sharper taper (narrower top, wider bottom — already polygonal, just tweak clip-path).
- Add a second inner-core layer (thin, pure white, ~40% width) for the bright central jet visible in the reference.
- Keep the existing flicker animation but speed it up slightly during `phase-liftoff`.

### 3. Smoke — `public/zerrow-landing.css` (`.smoke`, `.smoke i`, `@keyframes smokeDrift`)

- Increase puff count from 6 to ~10 and enlarge them (70–110px) so the base reads as a billowing cloud, not scattered dots.
- Stack puffs in two rows (some at `bottom:0`, some at `bottom:10–20px`) and vary sizes for volume.
- Brighten the radial gradient (warmer near-white center, soft gray edge) to match the reference's lit underside.
- Update `smokeDrift` keyframes: start small near the nozzle, expand and drift outward + slightly upward, fade out — so as the rocket lifts, the smoke visibly billows and trails behind.
- During `phase-liftoff`, add a brief upward+outward burst (shorter duration, larger end scale) so smoke "explodes" outward at takeoff.
- Add a few small bright spark `<i>` elements (or a `::before/::after`) drifting up with the flame, matching the orange sparks in the reference.

### 4. Phase timing — `src/components/landing/useMissionTelemetry.ts`

No logic changes needed; the existing `smoke → ignition → liftoff` phase progression already drives the CSS. The visual ordering (flame appears at ignition, smoke intensifies, rocket rises at liftoff) is purely a CSS concern handled above.

## Files

- `src/routes/index.tsx` — swap rocket SVG markup (~lines 155–176)
- `public/zerrow-landing.css` — update `.exhaust*`, `.smoke`, `.smoke i`, `@keyframes smokeDrift` (lines ~557–644)

No JS/telemetry, layout, or backend changes.
