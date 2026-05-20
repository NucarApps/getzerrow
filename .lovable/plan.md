# Use the new rocket-A logo across landing + app

The uploaded `zerrow_logo_clean.png` has lots of whitespace and a stray orange dot on the right (looks like the period from a "Zerrow." wordmark). Crop to just the rocket-A mark and use it everywhere a Zerrow wordmark or sidebar header appears.

## Steps

1. **Crop and save the asset** — copy the upload to `/tmp`, use ImageMagick (via `nix run nixpkgs#imagemagick`) to trim whitespace and crop to just the left-side rocket-A mark (drop the orange dot on the right). Save the result to `src/assets/zerrow-logo.png` so it can be imported as an ES module.

2. **Landing page (`src/routes/index.tsx`)** — replace the inline `<svg>` inside `.brand__mark` (the triangle placeholder) with `<img src={logo} alt="Zerrow" />`. Keep the existing `Zerrow.` wordmark text and `[for Gmail]` sublabel beside it.

3. **App sidebar (`src/routes/_authenticated.tsx`)**
   - Sidebar header (line ~131): place the logo to the left of the `Zerrow` heading, height ~28px.
   - Mobile top bar (line ~53): place the logo to the left of the `Zerrow` text, height ~22px.

4. **No other changes** — favicon, OG image, login page, and email templates are not part of this request. Leave them alone.

## Out of scope

- Favicon / `public/favicon.ico` updates
- OG/Twitter share image
- Any color/theme changes
