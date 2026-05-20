Fix the launchpad countdown / rocket sequence on the landing page so it tells a clear three-phase story tied to the inbox counter.

## Problem

- The red `▼ routing…` ticker reaches `0` but the rocket only "hops" to `bottom: 280px` and stops — it never actually clears the viewport, so the moment feels unfinished.
- The exhaust plume and smoke are both rendered from the start, so there's no buildup. Today: full fire on frame 1, gentle "lift" at the end. The user wants: smoke first, then fire as the counter ticks down, then a real launch at zero.

## What changes

### 1. Drive the rocket in three phases (`useMissionTelemetry.ts`)

Replace the single "add `.lifted` at t=1" trigger with explicit phase classes on the rocket wrapper, based on the same `t ∈ [0,1]` progress already computed for the inbox burn-down:

| Phase | When | Class on `#rocket` |
|---|---|---|
| Pre-ignition | `t < 0.4` (count 1247 → ~880) | `phase-smoke` — only ground smoke, no exhaust |
| Ignition | `0.4 ≤ t < 1` (count ~880 → ~30) | `phase-ignition` — exhaust ramps in, shake intensifies, smoke thickens |
| Liftoff | `t === 1` (count = 0) | `phase-liftoff` — rocket translates fully off the top of the viewport |

The counter / `INBOX ZERO` swap stays exactly as it is — it's already correct; it just lacked a matching visual climax.

### 2. Stage the visuals in `public/zerrow-landing.css`

- `.exhaust` defaults to `opacity: 0; transform: scaleY(0.2)` (hidden during pre-ignition).
- `.rocket-wrap.phase-ignition .exhaust` → fades in to `opacity: 1`, `scaleY: 1` over 600ms, and the flicker keyframe picks up.
- `.rocket-wrap.phase-smoke .smoke i` → softer, slower drift (current animation, but lower opacity peak).
- `.rocket-wrap.phase-ignition .smoke i` → brighter, faster, more turbulent.
- `.rocket-wrap.phase-liftoff` → `transform: translate(-50%, -120%); transition: transform 1.6s cubic-bezier(.5,0,.2,1)` so the rocket actually exits the top of `.launchpad__viewport` (which has `overflow: hidden` already).
- Keep the existing `.rocket-wrap.lifted` rule but treat it as an alias of `phase-liftoff` for backward compatibility (or remove it — there's only one caller).

### 3. Reset / cleanup

- On unmount (already handled by the existing `cancelAnimationFrame` in the hook), also remove the phase classes so a re-mount restarts cleanly. The current `.lifted` class is never removed; the new code will manage `phase-*` via `classList.replace`.

## Out of scope

- No changes to telemetry numbers, MET clock, hero T-clock, or FAQ behavior.
- No changes to the rocket SVG itself.
- No changes to the inbox burn-down duration (stays 8s) or easing.

## Technical notes

- Phase transitions are derived inside the existing `step(ts)` rAF loop — no new timers. A small `currentPhase` local prevents redundant `classList` writes every frame.
- Liftoff transform uses `translate(-50%, -120%)` rather than `bottom`, because animating `transform` is cheaper and the rocket needs to clear the viewport regardless of its height. `.launchpad__viewport` already clips with `overflow: hidden`, so the rocket disappears cleanly past the top edge.
