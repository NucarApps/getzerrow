# Swap logo + remove "Zerrow" wordmark next to it

The new uploaded image already contains the "Zerrow." wordmark, so the separate text rendered next to the logo becomes redundant.

## Changes

1. **Replace `src/assets/zerrow-logo.png`** with the newly uploaded image (the logo with the integrated "Zerrow." wordmark).

2. **`src/routes/_authenticated.tsx`** — remove the `<span>Zerrow</span>` next to the topbar logo (line 97) and remove the `<h1>Zerrow</h1>` next to the sidebar logo (line 178). Keep the `AI inbox` tagline and bump the logo height slightly (sidebar `h-7` → `h-9`, topbar `h-6` → `h-7`) so the wordmark inside the image reads well.

3. **`src/routes/login.tsx`** — remove the `<h1>Zerrow</h1>` (line 90) under the login logo; the wordmark is already in the image. Keep the logo size.

4. **`src/routes/index.tsx` (landing nav)** — remove the `<span className="brand__word">Zerrow.</span>` (line 65) next to the nav logo. All marketing copy ("Zerrow reads every new email…", footer, meta tags) stays untouched.

No other text changes — page titles, meta descriptions, FAQ, and body copy still say "Zerrow".
