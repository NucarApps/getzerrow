## Problem

Two issues with the standby tracking view:

1. **Rocket is off the arc.** The trajectory `<path>` lives inside an SVG with `viewBox="0 0 600 400"` and `preserveAspectRatio="none"`, so it stretches to fill the container (e.g. ~1900×900). The rocket icon uses CSS `offset-path: path("M 30 370 Q 300 -120 570 90")`, which is evaluated in **raw CSS pixels** — a 600×400 coordinate space. The rocket therefore travels a tiny path in the top-left while the visible arc is stretched across the full pane.
2. **Animation is too fast.** The arc draw + rocket fly are both 14s loops.

## Fix

Edit `public/zerrow-landing.css` and `src/components/inbox/TrackingStandby.tsx` (plus the matching landing markup if it shares the same arc).

### a) Put the rocket inside the SVG so it scales with the arc

Replace the absolutely-positioned `.tracking__icon` div + CSS `offset-path` with an inline `<g>` inside the existing `<svg className="tracking__arc">`, animated via SVG `<animateMotion>` referencing the same path. Because the rocket now lives in the same `viewBox="0 0 600 400"` and uses the same path geometry, it sits exactly on the curve at every container size.

Sketch:

```tsx
<svg className="tracking__arc" viewBox="0 0 600 400" preserveAspectRatio="none">
  <defs>…gradient…
    <path id="arcPath" d="M 30 370 Q 300 -120 570 90" />
  </defs>
  <use href="#arcPath" className="tracking__arc-ghost" fill="none" />
  <use href="#arcPath" className="tracking__arc-live"  fill="none" stroke="url(#arcGradStandby)" />
  <g className="tracking__rocket">
    <g transform="translate(-6,-14) scale(0.12)">
      …existing rocket paths…
    </g>
    <animateMotion dur="28s" repeatCount="indefinite" rotate="auto" keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.6 1">
      <mpath href="#arcPath" />
    </animateMotion>
  </g>
</svg>
```

Note: `preserveAspectRatio="none"` stretches the path non-uniformly, which would visibly squash the rocket sprite at wide aspect ratios. Switch the SVG to `preserveAspectRatio="xMidYMid meet"` so both the arc and the rocket keep proportions. The visible arc shape will be unchanged conceptually (still spans the pane) but no longer squashed.

Delete the now-unused `.tracking__icon`, `.tracking__icon::before`, `@keyframes iconFly`, and `@keyframes iconFlame` rules.

### b) Slow the motion

- `.tracking__arc-live` `animation: arcDraw 14s ...` → **28s**.
- `<animateMotion dur="28s">` matches it so the rocket reaches apogee as the arc finishes drawing.

### c) Apply to the landing page too

The same arc + rocket markup exists on the landing page (driven by `useMissionTelemetry`). Make the same SVG-embedded-rocket change there so both views stay consistent.

## Verification

After the change: on any container size, the rocket sprite sits precisely on the live orange arc as it sweeps from launchpad to apogee, completing the loop in ~28s instead of 14s. No more drift to the upper-left corner.