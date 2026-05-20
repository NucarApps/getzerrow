## Goal

Produce a downloadable logo image of the existing "Zerrow." wordmark at 512x512 PNG with transparent background, matching the site's current rendering.

## Specs

- Text: `Zerrow.` — the period in muted gray (matches header treatment: `Zerrow` in white, `.` in `#9a9aa8`)
- Font: Sora Bold (same as the site header)
- Color: `#f4f3ee` (site foreground) for "Zerrow", `#9a9aa8` for the period
- Canvas: 512x512, transparent background, wordmark centered
- Output: `/mnt/documents/zerrow-logo-512.png`

## Approach

1. Use a small Python script with Pillow to render the wordmark.
2. Download the Sora Bold TTF from Google Fonts at runtime (no project dependency added).
3. Center the text on a 512x512 transparent canvas, size the font so the wordmark fills ~80% of the width.
4. Save to `/mnt/documents/zerrow-logo-512.png` and surface it via a `<presentation-artifact>` tag so you can download it.
5. QA: open the rendered PNG and verify rendering, kerning, color, and transparency before delivering.

No project source files will be modified — this is a one-off artifact generation.
