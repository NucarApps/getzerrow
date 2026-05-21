## Turn the standby pane into Space Invaders

Replace the current drifting-UFO + click-to-shoot game in `src/components/inbox/TrackingStandby.tsx` with a full Space Invaders clone. The rocket becomes the player ship at the bottom; alien email envelopes descend in waves; arrow keys move, space fires. Telemetry HUD chips and the starfield stay as backdrop, but the trajectory arc + autonomous rocket animation are removed (the rocket is now the player).

### Controls

- `←` / `→` or `A` / `D` — move player horizontally.
- `Space` (or `↑` / `W`) — fire. Cooldown ~280ms.
- `P` — pause/resume.
- `Enter` — start / restart after game over.
- Capture keys via a window listener while the component is mounted; `preventDefault` only for those keys so the rest of the app keeps normal scroll/tab behavior.
- Inline touch fallback: three small chips at the bottom (`◀`, `FIRE`, `▶`) shown only on coarse pointers (`@media (pointer: coarse)`), so mobile users aren't locked out.

### Game model (single RAF loop, fixed virtual playfield 100×100)

State held in `useRef` (not React state) for per-frame mutation; React state only for HUD (`score`, `lives`, `level`, `paused`, `gameOver`). One `useEffect` owns the RAF loop and reads/writes the refs.

- `player`: `{ x: number; cooldown: number }`, y fixed near bottom (~88). Move speed ~55 units/sec, clamped 6–94.
- `bullets`: `{ id, x, y }[]`. Player bullets travel up at ~95 units/sec; despawn off-top.
- `enemies`: grid `{ id, x, y, alive, hitUntil }[]`. Spawned per wave (see below). March left↔right at `marchSpeed`, drop one row when the formation hits an edge — classic Space Invaders sweep.
- `enemyBullets`: `{ id, x, y }[]`. Random alive enemies fire downward; rate scales with level. Bullets travel ~40 units/sec.
- `bursts`: existing particle-burst struct reused for kills + player death.

### Waves and escalating difficulty

`level` starts at 1. Each cleared wave: `level++`, spawn next wave.

Per level:
- `rows = min(5, 3 + floor(level / 2))`
- `cols = min(8, 5 + floor(level / 3))`
- `marchSpeed = 6 + level * 1.8` (units/sec horizontal); doubles after each row drop, capped at `30`.
- `enemyFireChancePerSec = 0.35 + level * 0.18`, capped at `2.5`.
- `enemyBulletSpeed = 38 + level * 3`, capped at `70`.
- Drop step on edge contact: `4 + min(level, 6)` units.

Game over when an enemy reaches `y >= player.y - 4` OR `lives` hits 0.

### Scoring + lives

- Score: 10 × `level` per kill, +50 bonus on wave clear.
- Player starts with 3 lives. On hit: lose 1 life, brief invuln flash (700ms), respawn at center; if `lives === 0` → game over.
- HUD chip top-center: `LEVEL 03 · SCORE 1240 · ♥♥♥`. Replaces the current `INTRUDERS NEUTRALIZED` chip.

### Player ship visual

Reuse the existing rocket SVG paths but pointed up and scaled for the new role (~5 units wide in the 100×100 playfield). Small orange thruster flicker beneath when moving. The arc, `<animateMotion>`, and earth curvature are removed — replaced by a thin orange ground line near the bottom and faint horizon glow.

### Enemy visual

Keep the envelope-with-antenna UFO (no flipping, no drift). Add a subtle 2-frame "wing flap" via toggling a CSS class every 600ms so the formation reads as marching, à la Space Invaders sprites.

### Sound

Keep `playPew` for player shots; add `playInvaderStep` (short low blip on each formation step) and reuse `playBoom` for kills and player death. All gated by `prefers-reduced-motion`.

### Reduced motion

If `prefers-reduced-motion`, render a static "PAUSED — REDUCED MOTION" overlay with the score chip and skip the game loop entirely; the user can still see HUD telemetry on the sides.

### Start / pause / game-over overlays

Three overlay states, centered, semi-transparent:
- Start (initial): `READY · PRESS SPACE TO LAUNCH`.
- Paused: `PAUSED · PRESS P TO RESUME`.
- Game over: `GAME OVER · LEVEL {n} · SCORE {s}` + `PRESS ENTER TO RESTART`.

The bottom caption (`AWAITING PAYLOAD…`) stays during gameplay as a faint label so the pane still reads as the inbox empty state.

### Files touched

- `src/components/inbox/TrackingStandby.tsx` — rewrite the game portion of the component (the telemetry tick, starfield, side HUD chips, and `playPew`/`playBoom` helpers stay; the click-to-shoot UFO drift logic, arc path, and `<animateMotion>` rocket are removed and replaced with the Space Invaders model described above). Inline `<style>` block for new keyframes (`thruster-flicker`, `enemy-step`, `invuln-blink`).

No new dependencies, no backend, no other files.
