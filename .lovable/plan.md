# Match rocket to reference image

Keep the existing animation phases (idle → ignition → liftoff) and DOM structure intact. Only rework the rocket's visual shape, the flame style, and the smoke clouds so they look like the uploaded reference: a sharp orange arrowhead rocket with a vertical white-to-orange flame column and big rounded puffy smoke clouds at the base.

## 1. Rocket SVG (`src/routes/index.tsx`, lines 157–174)

Replace the current SVG with a taller, sharper arrowhead silhouette matching the reference:

- **Body:** single tall triangle from a high apex down to wide base shoulders, split vertically into a lit orange left half (`#ff5a2e`) and a darker shadow right half (`#b8341a`) with a thin near-black centerline crease.
- **Fins:** two angular side fins flaring outward from roughly the lower third, each split into a lit face (`#ff5a2e`) and shadow face (`#8a2a14`); silhouette should read as wide, swept, and triangular like the reference.
- **Nozzle recess:** small dark V/notch at the base center (`#0a0e1a`) where the flame emerges.
- Keep viewBox proportions taller (e.g. `0 0 120 280`) so the rocket reads as slender and pointed.

## 2. Flame / exhaust (`public/zerrow-landing.css`, `.exhaust*` rules ~558–617)

Rework the plume to match the reference's tall, narrow, vertical column with a glowing white core:

- Make `.exhaust` narrower (~28px wide) and taller (~200px).
- `.exhaust__jet`: near-vertical bright white column (barely tapered), strong white center fading to pale yellow at edges.
- `.exhaust__core`: slightly wider orange sheath around the white jet — saturated orange (`#ff7a2e`) fading to deep red-orange at the bottom, with a soft outer glow.
- `.exhaust__halo`: warm orange radial glow hugging the top of the plume where it meets the nozzle.
- Keep the existing flicker keyframes and phase-based opacity/scale transitions.

## 3. Smoke clouds (`public/zerrow-landing.css`, `.smoke*` rules ~620–669)

Replace the soft blurred puffs with the reference's defined, rounded billowing cloud look:

- Each `.smoke i` becomes a crisp rounded puff: less blur (~1–2px), brighter near-white center (`rgba(255,250,245,.95)`), softer gray edge, sharper falloff — reads as a distinct cloud ball, not a haze.
- Cluster them in a wider, lower mound (broaden `.smoke` to ~380px, varied sizes from ~40px small outliers to ~120px central puffs) so the pile mirrors the reference's pyramid of clouds with a few small detached puffs to the sides.
- Add a subtle warm underglow tint on the puffs closest to the flame (inner puffs pick up faint orange from the exhaust).
- Keep the existing `smokeDrift` animation and per-phase timing; only restyle appearance and layout.

## 4. Out of scope

- No changes to launch sequencing, telemetry, JS, or surrounding layout.
- No new assets or libraries; pure SVG + CSS.
