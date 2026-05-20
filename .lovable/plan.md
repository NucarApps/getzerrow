# Swap in the new logo asset

The uploaded `zerrow_logo_clean-2.png` is the same rocket-A mark but with different framing. The dot on the right is the period from the wordmark — drop it.

## Steps

1. Copy upload to `/tmp/logo_raw.png`.
2. ImageMagick: crop the left ~35% (keeps the rocket-A, drops the dot), trim whitespace, save to `src/assets/zerrow-logo.png` (overwrites existing). Existing imports in `src/routes/index.tsx` and `src/routes/_authenticated.tsx` automatically pick it up.

No code edits needed.
