## Problem

The layout root in `src/routes/_authenticated.tsx` uses `min-h-screen`, so when the message list grows tall, the whole page (sidebar included) stretches with it. The sidebar's own internal scroll (`overflow-y-auto` on the folder list at line 176) never kicks in because the aside has no bounded height.

## Fix

One-line change in `src/routes/_authenticated.tsx` (line 42):

- `min-h-screen` → `h-screen`

That pins the root flex container to the viewport. The aside (already `md:flex md:flex-col`) becomes full viewport height, its inner folder list (`flex-1 overflow-y-auto`) starts scrolling when it overflows, and `<main className="flex min-w-0 flex-1 flex-col overflow-hidden">` keeps the message list as the only thing that scrolls.

No changes needed in `src/routes/_authenticated/index.tsx` — the inbox already manages its own scroll inside the `<main>` area.

## Files

- `src/routes/_authenticated.tsx` — swap `min-h-screen` to `h-screen` on the root `<div>`.
