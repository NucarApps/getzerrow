# Bust the cached logo

Your browser is serving an old cached version of `zerrow-logo.png` (just the rocket, no wordmark). The file on disk is correct (935×319 with rocket + "Zerrow." wordmark), but the browser is reusing the old PNG.

## Change

Rename the asset so Vite emits a fresh hash and bypasses cache entirely:

1. Move `src/assets/zerrow-logo.png` → `src/assets/zerrow-logo-v2.png`.
2. Update the 4 import lines:
   - `src/routes/index.tsx`
   - `src/routes/_authenticated.tsx` (the single import is reused twice)
   - `src/routes/login.tsx`

   Change `import zerrowLogo from "@/assets/zerrow-logo.png"` → `"@/assets/zerrow-logo-v2.png"`.

No other code changes.
