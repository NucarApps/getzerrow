
# Rocket Countdown Homepage

Re-theme the landing page around a "T-minus to inbox zero" rocket launch metaphor while keeping the existing dark palette (#0c0c14 background, gold #e0b54a accent, Sora + Instrument Serif type).

## What changes

**Hero — replace the cobweb card with a rocket launch visualization**

Right column becomes a tall vertical "launch pad" panel:
- A stylized rocket (SVG) sitting on a launch gantry, with animated exhaust flame flickering at the nozzle
- Animated starfield + parallax behind it
- A large countdown ticker overlaid: `T - 00:00:03 · 02 · 01 · 00` cycling down to `ZERO` (the word LIFTOFF / INBOX ZERO flashes when it hits 0)
- When the countdown reaches zero: rocket lifts off (translateY up + smoke trail), then resets after ~2s
- Subtle gold glow + screen shake at ignition

Left column copy shifts subtly to match the theme:
- Eyebrow: "T-minus to Inbox Zero"
- Headline keeps "An inbox that *sorts itself*"
- Replace "Connect Gmail" CTA microcopy line with "Free to try · 3, 2, 1, launch"

**Header**
- Wordmark tweak: `Zerrow` with the trailing `.` replaced by a small rocket icon (▲ stylized) in gold

**Marquee → Launch checklist**
Reframe the chip strip as a pre-launch systems check:
`NEWSLETTERS · GO` · `INVOICES · GO` · `COLD PITCHES · GO` ... in mono-ish tracking. Each chip prefixed with a small green dot.

**How it works → Mission stages**
Rename steps to mission phases:
- `T-3 · Ignition` — Connect Gmail
- `T-2 · Trajectory` — Describe your folders
- `T-1 · Liftoff` — Open a clean inbox
Add a thin vertical "launch rail" line connecting the three cards on desktop.

**Big statement** — keep, lightly reword the italic tail: *"Zerrow is the countdown that finally gets you to zero."*

**CTA section**
- Headline: "Ready for liftoff?"
- Button label: "Start the countdown"
- Add faint rocket silhouette + trail behind the gold panel

**Footer** — unchanged.

## Technical notes

- New component `RocketCountdown.tsx` in `src/components/landing/` containing the SVG rocket, starfield, countdown timer (useState + setInterval, cycle 5s → liftoff → 1s reset), and exhaust flame animation. Pure CSS keyframes for flame/stars/liftoff; no new deps.
- New inline SVG assets (rocket, gantry, star dots) — no image generation needed; keeps bundle small and themable via currentColor + GOLD token.
- Keep all existing typography tokens (Sora, Instrument Serif, Manrope) and color constants. Add one keyframe set for `flicker`, `twinkle`, `liftoff`, `shake` to a small `<style>` block scoped in the component.
- Respect `prefers-reduced-motion`: countdown still ticks but liftoff/shake disabled.
- No backend changes, no route changes, no new packages.

## Files touched
- `src/routes/index.tsx` — section copy/structure updates listed above
- `src/components/landing/RocketCountdown.tsx` — new

## Out of scope
- Inbox/app UI (this is homepage only)
- Replacing the gold accent or the existing dark palette
- 3D / WebGL rocket (SVG + CSS only for performance + reduced-motion safety)
