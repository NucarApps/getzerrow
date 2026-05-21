# Slow the standby telemetry arc + remove the slow start

## Scope
Only the **inbox standby** view (`TrackingStandby.tsx`, shown when no email is selected). The landing page rocket stays as it is.

## Current behavior
- Rocket: `<animateMotion dur="28s" calcMode="spline" keySplines="0.4 0 0.6 1">` — eases in (slow start) and finishes in 28s.
- Arc draw: shared CSS `.tracking__arc-live { animation: arcDraw 28s ease-in-out infinite }`.

Two problems: (1) far too fast, (2) the ease-in spline + ease-in-out arc make the rocket sit still for the first few seconds.

## Fix

### 1. `src/components/inbox/TrackingStandby.tsx`
- Change `<animateMotion>` to `dur="180s"` (3 minutes) and switch `calcMode="spline"` + `keySplines` to `calcMode="linear"` so the rocket moves at constant pace from the very first frame (no slow start).
- Add an extra class to the live arc `<use>`: `className="tracking__arc-live tracking__arc-live--standby"` so we can override the draw timing without touching the landing page.

### 2. `public/zerrow-landing.css`
- Add a scoped override:
  ```css
  .tracking__arc-live.tracking__arc-live--standby {
    animation: arcDrawStandby 180s linear infinite;
  }
  @keyframes arcDrawStandby {
    0%   { stroke-dashoffset: 900; }
    95%  { stroke-dashoffset: 0; opacity: 1; }
    100% { stroke-dashoffset: 0; opacity: 1; }
  }
  ```
  Linear draw paced to match the 180s rocket motion, so the trail keeps up with the rocket immediately and the whole loop takes ~3 minutes end-to-end.

## Result
- Rocket starts moving the instant the standby view appears.
- It crawls along the arc, reaching the end at ~3 minutes, with the glowing trail drawing in lockstep.
- Landing page animation is untouched.
