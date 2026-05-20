# Replace Zerrow logo

Overwrite `src/assets/zerrow-logo.png` with the uploaded image (`user-uploads://ChatGPT_Image_May_20_2026_07_16_34_PM.png`).

All three usage sites already import from `@/assets/zerrow-logo.png` and will pick up the new file automatically — no code changes needed:
- `src/routes/index.tsx` (landing nav)
- `src/routes/_authenticated.tsx` (sidebar + topbar)
- `src/routes/login.tsx` (sign-in page)
