# Telemetry empty state for the reading pane

When no email is selected, replace the plain "Select an email" text in the right-hand reading pane with a mission-control style "telemetry tracking" panel that matches the landing page's spaceship vibe.

## What the user sees

A dark panel centered in the reading area with:
- A small header strip: blinking orange status dot + monospace label `TELEMETRY • STANDBY` and a live MET clock (`T+00:00:12`) on the right.
- An ASCII / SVG mini rocket trail with a soft animated glow at the base.
- A 2-column grid of live-updating telemetry readouts in JetBrains Mono:
  - ALT (km), VEL (m/s), THRUST (%), FUEL (%), G-FORCE, HDG (°)
  - Values jitter every ~250ms with small random walks, same feel as the landing page.
- A footer line: `AWAITING PAYLOAD — select a transmission from the queue` (replaces "Select an email").
- Subtle scanline / grid background using existing tokens (border, muted, primary as the orange accent).

All styling uses semantic tokens from `src/styles.css` (`--primary` orange, `--muted-foreground`, `--border`, `--card`) plus the `JetBrains Mono` font already loaded globally. No new colors.

## Files

- **`src/components/inbox/TelemetryStandby.tsx`** (new) — self-contained component. Owns its own `useEffect` interval for MET clock + jittering telemetry numbers. Cleans up on unmount. ~80 lines, no external deps.
- **`src/routes/_authenticated/inbox.tsx`** — line 541-545: replace the empty-state `<div>` with `<TelemetryStandby />`. Import added at top.

## Out of scope

- No changes to the Reader (selected email) view.
- No changes to landing page telemetry.
- No new assets or fonts.
- No backend / data wiring — values are purely cosmetic client-side jitter.
