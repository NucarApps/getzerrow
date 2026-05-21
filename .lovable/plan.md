## Two changes to the inbox standby mini-game

### 1. Aliens appear at random spots instead of streaming across

Today ships spawn off-screen and drift edge-to-edge. Switch to "pop-in" UFOs that appear at a random `(x, y)` anywhere inside the safe play area, hover with small drift, then warp out.

- Spawn position: `x` in 12–88%, `y` in 18–62% (avoid HUD chips in the corners and the score chip up top).
- Lifespan: 6–10s. Fade/scale in over 250ms on spawn, fade/scale out over 250ms before despawn.
- Drift: each ship gets a small random velocity (±0.6% per second on each axis); clamp inside the play area so they wander a little without sliding off.
- Cap stays at 3 on-screen, spawn cadence stays 3.5–6s.
- Off-screen culling logic (`nx < -12 || nx > 112`) is removed — replaced by the lifespan timer.
- Ship orientation no longer needs `dir` flipping since they hover; keep the envelope upright. Remove the `dir`/horizontal-flip transform.

### 2. Laser fires from the rocket on the trajectory

Replace the fixed `(50%, 100%)` laser origin with the rocket's current screen position along the orange arc.

Implementation:
- Add a `useRef` for the arc `<path id="arcPathStandby">` element.
- Add a helper `getRocketPoint()` that:
  1. Reads the path's total length and computes the rocket's current length using the same `dur="420s"` / `repeatCount="indefinite"` mapping as `animateMotion` (`(performance.now() / 420000) % 1 * totalLength`).
  2. Calls `path.getPointAtLength(len)` to get a point in the arc SVG's 600×400 viewBox.
  3. Converts that to client coords via `path.getScreenCTM()` → `DOMPoint.matrixTransform`, then to container percentages via `containerRef.current.getBoundingClientRect()`.
- On ship click, set the laser's `(fromX, fromY)` to that computed rocket point (in 0–100% game-layer coords) instead of `(50, 100)`. Everything else about the laser (length, angle, fade) already derives from from/to, so no other changes.
- Time origin: align the rocket length calc to the same `performance.now()` clock the loop already uses; `animateMotion` starts at component mount so using `performance.now()` directly is close enough visually (the rocket creeps slowly and the laser is 200ms — sub-pixel drift is invisible).

### Files touched

- `src/components/inbox/TrackingStandby.tsx` — adjust `Ship` type (drop `dir`, add `vx`, `vy`, `spawnedAt`, `lifespan`), rewrite the spawn block and RAF loop's ship update, remove the horizontal-flip transform, add `arcPathRef` + `getRocketPoint()`, swap laser origin in `handleShipClick`. Add small spawn/despawn fade via inline CSS keyframes.

No backend, no new dependencies.
