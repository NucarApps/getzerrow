## Fix the Space Invaders ship aspect ratio

The game's outer `<svg>` is set to `viewBox="0 0 100 100"` with `preserveAspectRatio="none"` and stretches to fill the (wider-than-tall) game container, so every child — including the ship `<image>` — is non-uniformly stretched horizontally. The PNG asset itself is correct (187×265, portrait). The fix is to compensate for that horizontal stretch on the ship element only, so its rendered aspect matches the source PNG.

### Change — `src/components/inbox/TrackingStandby.tsx`

1. Add a `containerRef` on the game's root wrapper `<div>` (the parent of the `<svg viewBox="0 0 100 100">`).
2. Track `{ w, h }` of that container with a `ResizeObserver` in a `useEffect`, stored in `useState`.
3. Derive a corrective ship box every render:
   - Source aspect (W/H) `SRC = 187 / 265 ≈ 0.706`.
   - Effective stretch factor `S = (containerW / containerH)` (because viewBox is square 100×100).
   - Render the ship `<image>` with `height = 9` (unchanged) and `width = 9 * SRC / S`, then re-center: `x = -width / 2`, `y = -5.2`.
   - Keep `preserveAspectRatio="xMidYMid meet"`.
4. Fallback: if `containerH === 0` (first paint before observer fires), use the current `width={7}` as before so nothing flashes broken.

This makes the ship render with the same proportions as the uploaded PNG regardless of game container size, without touching gameplay coordinates (`PLAYER_Y`, `PLAYER_HALF_W`, collision math) or the rest of the SVG.

### Out of scope

- No change to the home-page rockets (their SVGs use a proper square-ish viewBox and `preserveAspectRatio="meet"`, so they already render correctly).
- No change to the PNG asset, gameplay logic, or hit-box constants.
- Thruster polygon stays as-is (small, symmetric — stretching is visually negligible).