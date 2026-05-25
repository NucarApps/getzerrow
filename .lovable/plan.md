# Fix: rocket reappears after blast-off

## Problem

After release, the rocket correctly blasts off the top — but then the `returning` phase plays a `rocket-return` animation that fades a fresh rocket back in from the bottom of the pull zone before collapsing. To the user this reads as "blast off → reappear → go back up again", which breaks the illusion.

## Fix

Treat blast-off as terminal. Once the rocket leaves the screen, just collapse the pull zone to 0 and reset to idle — no return animation, no second rocket. The next time the user pulls, a fresh rocket is revealed naturally by the existing pull logic.

### Changes

- `src/components/inbox/PullToRefresh.tsx`
  - After `await onRefresh()` and the min-visible delay, skip the `returning` phase. Go straight to `idle` with `pull = 0`.
  - During `launching`, keep the indicator zone height fixed (96px) so the blast-off animation has room. Once we transition to `idle`, the existing height transition collapses the zone smoothly.

- `src/components/inbox/RocketIndicator.tsx`
  - Remove the `returning` branch (or leave it unused). Rocket is invisible (`opacity: 0`) in idle with `pull === 0`, which is already the default.

- `src/styles.css`
  - Leave `rocket-return` keyframe in place (harmless) or remove it. Either way it stops being referenced.

## Out of scope

No changes to the pull gesture, threshold, blast-off animation, or refresh behavior — only the post-launch return is removed.
