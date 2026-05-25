## Problem

Company logos render inside a `bg-card` tile (dark in dark mode). Logos with transparent backgrounds and dark ink (e.g. BlueOwl's dark blue owl) disappear against the dark tile.

## Fix

Update `src/components/contacts/CompanyLogo.tsx` so the `<img>` always sits on a light, near-white tile regardless of theme:

- Swap the `bg-card` class on the image for a fixed light surface: `bg-white` with a hairline `ring-1 ring-border/40` so it still reads cleanly against the dark page.
- Add a tiny inner padding (`p-0.5`) so the logo art doesn't touch the tile edge.
- Keep the monogram fallback exactly as-is (it already uses `bg-primary/15` + primary text and reads fine in both themes).

Logos that ship with their own colored background still fill the tile and look identical; transparent dark logos now sit on white and become legible.

## Out of scope

- No changes to the logo proxy, fetching, fallback chain, or dominant-color extraction.
- No per-logo "is it dark?" detection — a single light tile is simpler and covers every case without an extra canvas read.
- No light-mode visual change beyond the new hairline ring (white tile on a light page is effectively invisible, ring keeps the edge defined).