# Replace logo with new upload

The previous turn didn't actually copy the uploaded image into `src/assets/zerrow-logo.png` — the file on disk is unchanged, so you're still seeing the old logo.

## Change

1. Copy `user-uploads://IMG_2149.png` → `src/assets/zerrow-logo.png` (overwrite).

No code changes needed — all four render sites (`index.tsx`, `_authenticated.tsx` topbar + sidebar, `login.tsx`) already import this asset at the larger sizes set last turn.
