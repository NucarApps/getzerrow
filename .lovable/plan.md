# Widen the inbox game & refine its look

Make the Space-Invaders empty-state game (`TrackingStandby`) full-bleed widescreen, drop the muddy brown "tracking" arc backdrop, and give the sprites/effects a refined, minimal polish that matches Zerrow's UI. Gameplay balance is retuned to fit the wider field.

## What changes for you

- The game fills the whole inbox area edge-to-edge instead of a narrow ~900px 4:3 box in the middle.
- The brown semicircle arc and the Downrange / Apogee / Pitch telemetry readouts are removed. Behind the game is a clean dark space background with a subtle, slow-drifting starfield.
- Enemies (envelopes), bullets, bunkers, explosions, and the player ship get a cleaner look with soft glow, smoother particles, and crisper shapes — polished but understated.
- The ship moves across a wider lane, enemy formations spread wider, and bunkers/UFO/boss/spawns are repositioned so the wider field plays well.

## The widescreen field

Today the world is a fixed 100×100 coordinate space rendered in a `max-w-[900px]`, 4:3 box, so on wide screens it letterboxes into a narrow square. The fix introduces a wider world (160×100, i.e. 16:10) and remaps every hard-coded horizontal number to it, then lets the container fill the available space.

```text
Before:  [   ████ 4:3 900px ████   ]   <- narrow, centered, brown arc behind
After:   [████████ 16:10 full-bleed ████████]  <- edge to edge, clean bg
```

## Backdrop

- Remove the decorative `.tracking` block (arc + telemetry HUD) from `TrackingStandby.tsx` and the telemetry ticker `useEffect` that only fed it.
- Replace with a clean dark background plus a refined, subtle starfield layer (small, low-opacity, slow parallax drift).

## Refined visuals & effects

- Add reusable SVG filters (soft outer glow / faint bloom) and use design tokens where possible instead of scattered hex values.
- Enemies: consistent, cleaner envelope glyph per kind with a subtle colored glow; keep the urgent "!" and phishing zig-zag.
- Bullets: thin glowing rounded shots with a faint trail; enemy bullets get a matching soft glow.
- Bunkers: rounded, refined blocks that read clearly on the dark bg.
- Explosions: smoother expanding ring with eased fade + a few spark particles instead of the current stiff 6-dot ring.
- Player ship: subtle glow, refined thruster, cleaner shield ring.
- Floating score text and power-ups: lighter, more legible styling.

## Gameplay tuning for the wider field

Spacing, speeds, and spawn ranges are scaled to the 160-wide world so it feels balanced rather than empty: ship speed and clamp bounds, enemy column spacing, formation start/bounce bounds, bunker positions (spread across the width, likely one extra bunker), UFO travel path, boss start/patrol, and power-up drift stay within the new bounds.

---

## Technical details

**`src/lib/invader/engine.ts`**
- Add `FIELD_W = 160`, `FIELD_CX = 80` (keep `FIELD_H = 100`).
- `spawnBoss`: `x: 50` → `FIELD_CX`.
- `spawnBunkers`: replace `xs = [20,50,80]` with a wider spread (e.g. 4 bunkers at ~`[26,60,100,134]`) proportional to `FIELD_W`.
- Widen `COL_GAP` slightly and/or keep, so formations use more of the width.
- Leave `formationBounds`, `hitBunker`, scoring pure logic intact (they already derive from constants).

**`src/lib/invader/useInvaderGame.ts`**
- `playerXRef` start `50` → `FIELD_CX`; player clamp `px > 94` → `FIELD_W - 6`, and the lower `px < 6` bound stays.
- `formationXRef` start/reset `10` → a centered origin derived from `FIELD_W` and current cols.
- Formation bounce bounds (`2` and `98`) → `2` and `FIELD_W - 2`.
- UFO spawn x / travel and any `50`/`100` horizontal literals → `FIELD_CX` / `FIELD_W`.
- Return values unchanged in shape.

**`src/components/inbox/invader/GameField.tsx`**
- `viewBox="0 0 100 100"` → `0 0 ${FIELD_W} 100`; horizon line/rect width `100` → `FIELD_W`.
- Container: drop `max-w-[900px]` + `aspectRatio:"4 / 3"`; use full width/height with `aspectRatio: "16 / 10"` (or `FIELD_W/100`) so it fills the inbox area with no letterbox; ship stretch compensation stays and self-normalizes.
- Add `<defs>` glow filters; restyle enemies, bullets, bunkers, bursts, particles, ship, powerups, floats per the refined-minimal direction.

**`src/components/inbox/TrackingStandby.tsx`**
- Remove the `.tracking` JSX backdrop block and the telemetry `useEffect`/state; keep the game, HUD, overlay, pause and touch controls.
- Add a lightweight refined starfield background.

**Verification**
- `tsgo` typecheck, then drive the running preview with Playwright at a wide viewport to confirm full-bleed layout, no brown arc, and that the ship/enemies/bunkers stay within bounds; capture a screenshot to confirm the refined look.

No backend, data, or gameplay-logic-rule changes beyond spatial tuning; filter engine and score submission are untouched.