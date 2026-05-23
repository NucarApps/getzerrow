## Problem

On mobile, the entire inbox page scrolls — the title/search bar at the top and the pagination footer at the bottom move with the email list, instead of staying pinned while only the list scrolls in the middle.

## Cause

The inbox is laid out as a flex column (header → search → scrolling list → pagination footer) inside a `grid h-full` container. The middle list uses `flex-1 overflow-y-auto`, but it's missing `min-h-0`. In a flex column, children default to `min-height: auto`, which lets the list grow to fit all its rows instead of clipping at the parent's height. That pushes the footer below the viewport and makes the whole page scroll on mobile (where there's no separate reading pane absorbing the height).

The reader pane has the same shape and the same latent issue.

## Changes

All in `src/routes/_authenticated/inbox.tsx` — CSS-only, no logic changes:

1. **List scroll container (line 440)** — add `min-h-0` so it clips to the available space between the sticky header/search and the pagination footer.
   - `className="flex-1 overflow-y-auto"` → `className="min-h-0 flex-1 overflow-y-auto"`

2. **List column wrapper (line 403)** — add `min-h-0` so the flex column itself can shrink inside the grid row on mobile.
   - `h-full flex-col overflow-hidden ...` → `h-full min-h-0 flex-col overflow-hidden ...`

3. **Reader column wrapper (line 820)** — same `min-h-0` for symmetry, so the open-email view also only scrolls its body, not the toolbar.

4. **Reader body scroll (line 1085)** — add `min-h-0` to `flex-1 overflow-y-auto` for the same reason as #1.

5. **Outer grid (line 401)** — add `min-h-0` to `grid h-full` so the grid honors its parent's bounded height on mobile.

## Validation

- Open `/inbox` on the mobile viewport (402×716).
- Confirm the title row + search bar stay pinned at the top, the Prev/Page/Next footer stays pinned at the bottom, and only the email list scrolls in between.
- Open an email and confirm the toolbar header stays pinned while only the email body scrolls.
- Re-check desktop (≥768px) to confirm nothing regressed.
