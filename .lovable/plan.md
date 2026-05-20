## Problem

The white email-body card shrinks to fit its content (currently `minHeight: 120px`). For short emails like the Nissan/NuCarPulse "Daily Sales Report", that produces a thin white sliver at the top of the reading pane with a large empty dark void below — making the reader feel "way too small".

The card already spans the full width of the right pane; the issue is purely vertical.

## Fix

In `src/routes/_authenticated/inbox.tsx`, update `EmailBodyFrame` so the iframe always fills the available vertical space when the email's natural height is small:

1. Change the iframe's `minHeight` from `120` to something like `60vh` (or `500px` as a safe absolute floor).
2. In the `resize()` function, keep growing the iframe to fit tall emails as today, but never shrink below that new minimum — i.e. use `Math.max(naturalHeight + 4, minHeight)` where `minHeight` matches the CSS value.

Result: short emails render in a generously sized white card that fills most of the pane; long emails still expand normally up to the existing 4000px cap.

No other layout changes (middle list stays 400px, right pane stays `1fr`, reply box stays anchored at the bottom).

## Files

- `src/routes/_authenticated/inbox.tsx` — `EmailBodyFrame` (lines ~79–110): update `style.minHeight` and the `resize()` math.
