## Goal

Switch the marketing pages (`/`, `/privacy`, `/terms`) from the Paper & Ink light palette to the dark theme the rest of the app uses, so visitors land in the same visual world they'll get after signing in.

## App theme (reference)

From `src/styles.css`:
- Background: deep cool near-black (`oklch(0.16 0.012 270)`)
- Foreground: near-white
- Primary accent: warm amber/gold (`oklch(0.78 0.16 75)`)
- Borders/cards: dark slate variants

## Changes

**`src/routes/index.tsx`** — replace the local PAPER/INK constants with dark tokens and rework section-level color choices:
- Page background: deep near-black; body text: near-white / muted slate
- Header: same dark bg with subtle border, gold "Sign in" pill
- Hero: keep Sora + Instrument Serif italic, but italic phrase uses the warm gold accent; CTA button is gold-on-black; mock inbox card becomes a raised dark card with subtle border
- Marquee strip: slightly lighter dark band, muted uppercase text
- Features: dark bg, numbered kickers in gold, headings in white, body in muted slate
- How it works: invert — this section becomes the *lighter* dark band (cards on slightly elevated bg) so it still reads as a distinct stripe
- Big statement: italic phrase in muted slate
- FAQ dividers in subtle border color
- CTA card: gold background with dark text (flip of current) for punch
- Footer: dark, muted links

**`src/routes/privacy.tsx`** and **`src/routes/terms.tsx`** — same constant swap so header, headings, body text, and links match the new dark palette.

No structural/markup changes, no new routes, no dependency changes. Pure styling.

## Out of scope

- Auth-side UI (already dark, untouched)
- Replacing the cobweb-inbox SVG (stays as-is on the dark hero card)
- Migrating away from inline style constants to CSS tokens (could be a follow-up, but not needed to match)
