## Concept

Turn the inbox-empty `TrackingStandby` view into a lightweight ambient mini-game while keeping the existing telemetry + rocket arc as the backdrop. The rocket slows down, and "alien email" ships drift across the sky. Click one to fire a laser; a couple of hits and it explodes with a little burst + score tick.

This stays purely cosmetic — no backend, no email data, no router changes. Only `src/components/inbox/TrackingStandby.tsx` and a small CSS additions block in `public/zerrow-landing.css` (or a scoped `<style>` in the component) for keyframes the existing stylesheet doesn't already cover.

## Behavior

- Rocket: change `<animateMotion dur="180s">` to ~`420s` so the arc traversal is slow + meditative instead of zippy.
- Alien ships: spawn every 3.5–6s at a random Y (15%–65% of pane height), drifting left→right or right→left at 18–28s per crossing. Cap at 3 on-screen at once. Despawn when off-screen.
- Ship visual: a small envelope-shaped SVG (≈28×20px) with a faint orange glow ring so it reads as "email + UFO". Slight bob via CSS `@keyframes ufo-bob`.
- Hit points: 2 per ship. First click → flash white + small shake. Second click → explode (particle burst of 6–8 orange dots animating outward + fade), then remove.
- Laser: on click, draw a 180ms line from bottom-center of the pane to the click point using an absolutely-positioned thin div with `transform: scaleY` from 0→1 and a quick fade. Plays a short WebAudio "pew" (sine sweep 880→220Hz, 80ms, gain 0.04) — no asset files needed, generated inline via `AudioContext`. First click anywhere initializes audio (browsers require user gesture).
- Score HUD: add a third HUD chip top-center: `INTRUDERS NEUTRALIZED · 003`. Increments on each kill. Resets only on remount.
- Pointer: ships have `cursor: crosshair`; the rest of the pane keeps `pointer-events-none` on existing decorative layers so telemetry stays read-only.

## Implementation notes

- Keep all game state in `useState`/`useRef` inside `TrackingStandby` — `ships: {id, y, dir, x, hp, hitFlashUntil}[]`, `bursts: {id, x, y, startedAt}[]`, `lasers: {id, x, y, startedAt}[]`, `score: number`.
- Single `requestAnimationFrame` loop drives ship X position and prunes expired lasers/bursts; the existing 600ms `setInterval` telemetry tick stays untouched.
- Click handler on each ship (`onPointerDown`, `stopPropagation`) decrements HP, pushes a laser from `(50% bottom)` to the ship's current `(x, y)`, and on kill pushes a burst + `score++`.
- Respect `prefers-reduced-motion`: if set, skip ship spawning and audio, leave the slowed rocket + telemetry only.
- The bottom caption changes from `AWAITING PAYLOAD — SELECT A TRANSMISSION` to `AWAITING PAYLOAD — NEUTRALIZE INTRUDERS WHILE YOU WAIT` to hint at the interaction without nagging.

## Files touched

- `src/components/inbox/TrackingStandby.tsx` — state, RAF loop, ship/laser/burst SVG layers, click handlers, audio helper, slowed `animateMotion`, score HUD, updated caption.
- Inline `<style>` block inside the same component for `@keyframes ufo-bob`, `.laser`, `.burst-particle`, `.ufo-hit-flash` — keeps the change self-contained and avoids editing the shared landing CSS.

No new dependencies.
