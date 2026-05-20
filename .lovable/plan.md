# Replace logo and increase size

## Changes

1. **`src/assets/zerrow-logo.png`** — overwrite with the newly uploaded image.

2. **Bump display sizes everywhere the logo is rendered:**
   - `src/routes/index.tsx` (landing nav): `height: 32` → `height: 56`
   - `src/routes/_authenticated.tsx` topbar (line 96): `h-7` → `h-12`
   - `src/routes/_authenticated.tsx` sidebar (line 176): `h-9` → `h-14`
   - `src/routes/login.tsx` (line 89): `h-20` → `h-28`

No other changes.
