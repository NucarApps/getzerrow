Bring the authenticated app (sidebar, inbox, settings) in line with the Zerrow landing page — same deep-space background, orange accent, bone text, and Space Grotesk / JetBrains Mono typography.

## What changes

1. **`src/styles.css` — retune design tokens to the landing palette**
   - Background / sidebar: deep navy `#0a0e1a` / `#0d1220` / panel `#131826`
   - Foreground: bone `#f5f5f0`, muted `#8a92a8`
   - Primary / ring: NASA orange `#ff6b3d`
   - Borders: `#232a3d`
   - Add `Space Grotesk` + `JetBrains Mono` to the Google Fonts import and expose `--font-display: 'Space Grotesk'` and a `--font-mono` token (landing already loads them via `zerrow-landing.css`, but the app needs them too).
   - All values written as `oklch()` to stay consistent with the existing token format.

2. **`src/routes/_authenticated.tsx` — add the landing's atmospheric background to the app shell**
   - Wrap the root `<div className="flex h-screen ...">` with a layered background: subtle orange + cyan radial glows, a faint 64px grid masked to the center, and a low-opacity starfield — same recipe as `body` / `body::before` / `body::after` in `zerrow-landing.css`, scoped to the app shell so it doesn't leak into auth/landing pages.
   - Sidebar stays on `bg-sidebar` (now the darker `#0d1220`) with a hairline `--line` border to match the landing panels.

3. **Inbox surface polish (`src/routes/_authenticated/inbox.tsx`)**
   - No structural changes. Only swap any hard-coded greys for semantic tokens so the new palette flows through (card, border, muted-foreground), and let the shell background show through with `bg-transparent` on the outer container.

## Out of scope

- No changes to inbox logic, folder logic, Gmail sync, or settings behavior.
- Landing page (`src/routes/index.tsx`) and `public/zerrow-landing.css` stay exactly as they are — they're the source of truth being mirrored.
- Login page stays on its current styling.

## Technical notes

- Token format keeps `oklch()` so shadcn components keep working; the hex values from the landing are converted (e.g. `#0a0e1a → oklch(0.14 0.02 265)`, `#ff6b3d → oklch(0.72 0.19 40)`).
- The atmospheric background is added as a single absolutely-positioned `<div aria-hidden>` inside the shell with `pointer-events-none` and `z-0`; main content sits on `relative z-10` so clicks aren't intercepted.
- `overflow-hidden` on the shell keeps the starfield/grid from causing scroll.
