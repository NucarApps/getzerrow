# Pull-to-refresh with rocket animation

Add a native-feeling pull-to-refresh gesture to the inbox email list. As the user drags down from the top, the Zerrow rocket (`src/assets/zerrow-ship.png`) is revealed behind the list. On release past the threshold, the rocket blasts off (upward + fade with an exhaust trail), the email list refetches, and on completion a new rocket settles back at rest for the next pull.

## Behavior

- Trigger: touch drag down when the inbox list is already scrolled to top (mobile + trackpad-friendly).
- Reveal: as the user pulls, a fixed-height "pull zone" above the list expands (0 → ~96px) with the rocket fading/scaling in and rotating slightly upright. Resistance curve (`pull * 0.5`) so it feels rubber-bandy.
- Indicator states:
  - Pulling (< threshold): rocket dim, subtle bob.
  - Ready (≥ threshold ~72px): rocket brightens, small "Release to refresh" caption.
  - Refreshing: rocket plays blast-off (translateY -200px, scale 0.7, opacity 0) with a short flame/smoke trail (CSS gradient + animated dots), list refetches.
  - Done: rocket re-enters from bottom of pull zone, settles to rest, zone collapses.
- Refresh action: `queryClient.invalidateQueries({ queryKey: ["emails"] })` and `["folders"]`, awaited; min visible time ~700ms so the animation reads.

## Where

- `src/routes/_authenticated/inbox.tsx` — the email list scroll container is the `<div className="min-h-0 flex-1 overflow-y-auto">` around line 667. Wrap its contents with a new `PullToRefresh` component, or attach handlers + a sibling indicator div.
- New component: `src/components/inbox/PullToRefresh.tsx` — owns touch listeners (`touchstart`/`touchmove`/`touchend`), pull distance state, threshold logic, and renders the rocket indicator. Accepts `onRefresh: () => Promise<void>` and `children`.
- New component: `src/components/inbox/RocketIndicator.tsx` — pure visual: takes `pull` (0–1+), `phase` ('idle' | 'ready' | 'launching' | 'returning'), renders the rocket image, flame trail, and caption.
- `src/styles.css` — add keyframes: `rocket-blastoff` (translateY -240px + fade + slight rotate), `rocket-return` (translateY from +40px to 0 with ease-out), `rocket-bob` (subtle idle hover), `flame-flicker`.

## Technical notes

- Only activate when `scrollTop === 0` at `touchstart`; otherwise let native scroll run.
- Use `passive: false` on `touchmove` so we can `preventDefault()` once pulling, to suppress overscroll bounce on iOS.
- Apply `overscroll-behavior: contain` to the scroll container to prevent the page itself from rubber-banding while we own the gesture.
- Pointer Events fallback for trackpad: also listen for `wheel` with negative `deltaY` at scrollTop 0 to allow desktop testing (optional, low priority).
- Respect `prefers-reduced-motion`: skip blast-off, just show a spinner-style fade.
- Don't double-trigger: ignore new pulls while `phase !== 'idle'`.

## Out of scope

- No changes to email detail view, sidebar, or any other route.
- No backend changes — refresh is just a React Query invalidation; new emails already arrive via realtime.
