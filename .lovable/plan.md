# Fix Invader game performance

The game runs at 60 fps internally but every frame currently triggers a full React re-render of the entire game tree, with a lot of object churn. On any non-trivial scene (lots of bullets, particles, bursts, multi-bullets, slow-mo) this drops FPS and stutters.

## Root causes

1. **Whole-tree re-render every frame.** `useInvaderGame` calls `setFrameTick(...)` every RAF tick. That re-renders `TrackingStandby`, which rebuilds `state` (~25 fields) and re-renders `GameField`, `GameHUD`, and `GameOverlay` together. HUD and Overlay don't need to update at 60Hz.
2. **Per-frame object churn (GC pressure).**
   - `bulletsRef.current = bulletsRef.current.map(b => ({...b, x: ..., y: ...}))` for player bullets, enemy bullets, particles, floats. Same with `powerups`. Each frame allocates dozens of new objects + a new array.
   - Per-frame `state` object rebuild + new arrays passed as props to children.
3. **Many React state updates per kill.** `handleEnemyKill` fires `setScore`, `setKills`, `setCombo`, `setMaxCombo` (and `setLives` on hit). Each is a separate re-render path; with combos this multiplies.
4. **SVG render cost.** `GameField` renders 10 circles per burst, all particles, all bullets, with text/gradients. The `<image href={shipUrl}>` block recomputes `size` math inside an IIFE every render.
5. **Gamepad RAF loop runs even when not playing**, and `setFrameTick` runs even when paused/ready.

## Fix plan

### A. Decouple high-frequency render from React state
- Keep React state for things HUD/Overlay actually display: `phase`, `score`, `combo`, `maxCombo`, `kills`, `level`, `lives`, `activeBuff`, `newAchievements`. These flush at most every ~120ms via a coalescing scheduler, not per frame.
- Move the game-field rendering to an **imperative subscriber**: expose a `subscribe(listener)` from the hook. `GameField` becomes a component that owns its own `useState` "frame nonce" updated by its own subscription, and reads game data directly from refs exposed by the hook (e.g. `getSnapshot()` returning the same refs without re-allocating).
- `useInvaderGame` returns `refs` (bullets, enemies, particles, bursts, floats, powerups, bunkers, boss, ufo, formationX/Y, playerX, shakeUntil, shieldUntil) plus `subscribe` and `getReactState`.

### B. Stop allocating per frame
- Mutate bullets/enemyBullets/particles/floats/powerups **in place**: iterate with a write index and overwrite the same array (`arr.length = w`). No `.map(spread)`.
- Stop rebuilding the `state` object every render; HUD reads scalar React state, GameField reads refs.
- Cap collections defensively: max 80 particles, max 24 bursts, max 40 floats — drop oldest when exceeded.

### C. Batch per-kill updates
- Accumulate score / kills / combo into refs during the frame and flush once at end of frame inside the coalescing scheduler. `handleEnemyKill` no longer calls four setters.
- `setLives` stays inline (it can end the run).

### D. Memo + split children
- `GameHUD` and `GameOverlay` wrapped in `React.memo`; props become primitives so memo bails out cleanly when nothing changed.
- `GameField` re-renders only from its own subscription, not from parent.

### E. Loop hygiene
- Skip the loop body (and re-render) entirely when `phase !== "playing"`; only schedule next RAF.
- Gamepad poll: throttle to ~60Hz only while `phase === "playing"`; otherwise poll at ~10Hz.
- Compute `now = performance.now()` once and pass through; remove `useState({w,h})` ResizeObserver thrash by using `useRef` + reading on render (size is only read inside the IIFE).

### F. SVG micro-cuts
- Burst rings: 10 circles → 6.
- Particles: render as a single `<g>` of `<rect>`s without per-rect calculations beyond x/y/opacity (already small, mainly fewer of them via cap).
- Remove `Math.random()`-driven `dx/dy` shake when `shake === 0` (already guarded) — fine, but compute shake from a ref-read of `shakeUntilRef`, not state.

## Files touched

- `src/lib/invader/useInvaderGame.ts` — in-place mutation, coalescing scheduler, subscribe API, batched per-kill updates, gated loop.
- `src/components/inbox/invader/GameField.tsx` — subscribe to hook, read refs, memo, fewer burst rings, drop ResizeObserver state-thrash.
- `src/components/inbox/invader/GameHUD.tsx` — `React.memo`, primitive props.
- `src/components/inbox/invader/GameOverlay.tsx` — `React.memo`.
- `src/components/inbox/TrackingStandby.tsx` — adapt to new hook return shape (refs + subscribe + reactState).

No engine/game-logic changes, no DB changes, no gameplay tuning. Pure perf refactor.

## Validation

- After change: open `/inbox`, start a run, hold fire with `multi` powerup, ensure smooth motion at 60fps.
- Use `browser--performance_profile` before/after if needed to confirm fewer long tasks and lower script time per frame.
- Verify HUD numbers, combo timer, achievements, daily mode, pause, and game-over submission still work.