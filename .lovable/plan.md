## Replace home-page rocket with the Zerrow ship asset

Swap the hand-drawn SVG rocket on the landing page Launchpad with the same `src/assets/zerrow-ship.png` used in the Space Invaders game, so the brand ship is consistent across the app.

### Changes

**`src/routes/index.tsx`**

1. Add `import shipUrl from "@/assets/zerrow-ship.png"` at the top.
2. **Main launchpad rocket (lines ~220–238)** — replace the 7 `<path>` elements inside `<svg className="rocket" viewBox="0 0 120 280">` with a single `<image href={shipUrl} x="10" y="0" width="100" height="260" preserveAspectRatio="xMidYMid meet" />`. Keep the surrounding `.rocket-wrap`, `.exhaust`, `.smoke`, and `.sparks` markup untouched so the existing liftoff animation, exhaust glow, and smoke effects continue to work.
3. **Tracking-arc mini rocket (lines ~163–172)** — replace the 7 `<path>` elements inside `<g className="tracking__rocket">` with a single `<image href={shipUrl} x="20" y="0" width="80" height="230" preserveAspectRatio="xMidYMid meet" />` so the small rocket that travels the arc also uses the brand ship.

### Out of scope

- No CSS / animation changes (rocket-wrap, exhaust, smoke, arc motion all stay).
- No new asset generation — reuses the existing `src/assets/zerrow-ship.png`.
- Telemetry numbers, Launchpad chrome, and copy unchanged.