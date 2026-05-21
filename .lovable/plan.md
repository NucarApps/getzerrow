## Three changes to the Space Invaders standby pane

All in `src/components/inbox/TrackingStandby.tsx`. No other files, no backend.

### 1. Redraw aliens as proper email envelopes

Today the enemy SVG is ~3 units wide with a tiny envelope-plus-antenna squashed inside a `scale(0.055)` group — at small sizes it reads as a flat orange smudge.

Replace the enemy art with a recognizable envelope drawn directly in playfield units (no inner downscale), then bump grid spacing so the bigger sprites still fit:

- Envelope body: `5.4 × 3.6` rounded rect, dark-card fill, orange stroke.
- Triangular flap on top: two strokes from upper corners meeting at center (slight `flap` offset already toggles every 500ms — keep it, increases the "marching" read).
- Stamp: tiny `1 × 1` orange square in the top-right of the body.
- Subject lines: two thin horizontal lines inside the body.
- Drop the antenna + glow ellipse — they were what made it look UFO-ish; now it should read clearly as an email envelope.
- Hit-flash: invert fill (white body) for `hitUntil` window (already wired).
- Constants: `ENEMY_W = 5.4`, `ENEMY_H = 3.6`, `ENEMY_HALF_W = 2.7`, `ENEMY_HALF_H = 1.8`. Update collision from circle (`ENEMY_R`) to AABB using these.
- Grid gaps: `COL_GAP = 8.5`, `ROW_GAP = 6.5` so 8 columns × 5 rows still fit horizontally with margins.
- Update `formationBounds` to account for envelope width (clamp uses `minX - ENEMY_HALF_W` < 4 / `maxX + ENEMY_HALF_W` > 96).

### 2. Faster firing baseline + rapid-fire feel

- Lower `PLAYER_FIRE_COOLDOWN` from 280ms → **180ms**. Bullet speed up from 95 → 110.
- Add `playerCooldownMs` derived value: `activePowerup === "rapid" ? 80 : 180`.
- Multi-shot powerup also widens fire output (see below).

### 3. Power-ups

State additions (mostly refs):
- `powerupsRef: { id, x, y, kind: "rapid" | "multi" | "shield" | "life" }[]` — falling drops.
- `activePowerupRef: { kind, expiresAt } | null` — applies for ~8s after pickup; only one stackable buff at a time (later pickup replaces earlier). `shield` grants the invuln window directly (sets `invulnUntilRef = now + 6000`) and doesn't occupy the active slot. `life` is instant `setLives(l => Math.min(5, l + 1))` and doesn't occupy the slot. So only `rapid` and `multi` live in `activePowerupRef`.
- `[activePowerup, setActivePowerup]` React state mirror for HUD, updated whenever the ref changes.

Spawn rules:
- On each enemy kill, 14% chance to spawn a powerup at the dead enemy's `(x, y)`.
- Kind weights: `rapid 40%`, `multi 35%`, `shield 15%`, `life 10%`.
- Powerups fall at 22 units/sec. Despawn if `y > PLAYER_Y + 6`.
- Pickup: AABB vs player (`|dx| < PLAYER_HALF_W + 2`, `|dy| < 3`). On pickup → `playPickup` (short rising chirp) + apply effect.

Effects:
- `rapid`: 8s of 80ms cooldown.
- `multi`: 8s of triple-shot — fire emits 3 bullets at angles `[-8°, 0°, +8°]` from the player nose; same cooldown as base (180ms) so it doesn't double-stack with `rapid`.
- `shield`: 6s of `invuln` (reuses existing `invuln` blink class).
- `life`: +1 life, capped at 5.

Visual: glowing rounded pill, color-coded by kind, 1-letter label in mono — `R` orange, `M` cyan-orange `#67ffb8` for fresh-energy contrast, `S` blue `#7cc4ff`, `+` pink-amber `#ffb74d`. Gentle vertical bob.

HUD: add a second mini chip just under the LEVEL / SCORE chip when `activePowerup` is set:
`RAPID 4.3s` or `MULTI 2.1s` — countdown updates on the same RAF re-render.

Start overlay subtitle gains a line: `POWER-UPS DROP FROM EMAILS — CATCH THEM`.

### Type updates

```ts
type Powerup = { id: number; x: number; y: number; kind: "rapid" | "multi" | "shield" | "life" };
type ActiveBuff = { kind: "rapid" | "multi"; expiresAt: number };
```

### Sound

Add `playPickup` (square wave, 660→990Hz over 80ms, gain 0.05). Reuse existing helpers otherwise.
