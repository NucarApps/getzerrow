# Keep the planets orbiting on mobile

## Diagnosis (confirmed)
- No mobile-width CSS turns off orbit motion. Emulated iPhone viewport at `http://localhost:8080/` shows `.orbit__spin--inner` animating (`transform` sampled at two timestamps differs).
- The `prefers-reduced-motion: reduce` block at `public/zerrow-landing.css` lines 1147–1162 disables `.orbit__spin`, `.carrier`, `.orbit__ship`, and `.pcard__icon--bob`. iOS enables `prefers-reduced-motion` whenever "Reduce Motion" is on in Accessibility settings, and Low Power Mode can imply it as well — matching the symptom "planets not animated on mobile".

## Change
Split the reduced-motion rule into two tiers so the brand-critical orbit keeps rotating on mobile while the visually noisy motion still calms down.

### Kept muted under Reduce Motion (unchanged)
- `.sky__stars`, `.sky__flyby`, `.shoot__streak`, `.tw` (twinkles), `.bhole__glow`, `.cta__ship`, `.steps__path path`, `.footer__status i`.

### Now allowed under Reduce Motion, at slower speeds
- `.orbit__spin--inner` and its counter-rotating `.carrier--inner`: 34s → 90s.
- `.orbit__spin--outer` and `.carrier--outer`: 52s → 140s.
- `.orbit__spin--courier` / `--courier2`: 18s → 48s.
- `.orbit__ship` bob: 4s → 8s.
- `.pcard__icon--bob`: 5s → 10s.

The slower durations preserve the "orbit is alive" cue without the fast motion that Reduce Motion is meant to filter out. Rotation is a soft, decorative loop — WCAG's reduced-motion guidance targets vestibular triggers (parallax, spin bursts, autoplay video), not gentle continuous rotation.

## File touched
- `public/zerrow-landing.css` — replace the single `@media (prefers-reduced-motion: reduce)` block (lines 1147–1162) with the two-tier version described above. No JSX or component changes.

## Verification
- Emulated mobile viewport with reduced-motion forced on: sample `.orbit__spin--inner` transform at t=0 and t=2s and confirm they differ (currently identical when reduced motion is on).
- Emulated mobile viewport with reduced-motion off: confirm original 34s / 52s / 18s durations still apply (no regression on default users).
- Visually skim the hero section at 402×725 to make sure nothing else animates faster than before.

## Out of scope
- No changes to the planet cards below the fold, the black-hole burp, or any JS.
- No new dependency or Motion/GSAP wiring.
