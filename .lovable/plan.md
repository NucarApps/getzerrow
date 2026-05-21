## Problem

The Space Invaders standby game in `src/components/inbox/TrackingStandby.tsx` attaches a `window`-level `keydown`/`keyup` listener and calls `e.preventDefault()` on A, D, W, Space, Arrow keys, P, and Enter. Because the listener is global, it fires even when you're typing in the search bar (or any other input), which is why D, W, A, P, and Space don't reach the field.

## Fix

In the `onKeyDown` and `onKeyUp` handlers (lines 251–273), bail out early when the event originates from an editable element, before checking `isGameKey` or calling `preventDefault()`.

Editable check:
```ts
const t = e.target as HTMLElement | null;
if (
  t &&
  (t.tagName === "INPUT" ||
   t.tagName === "TEXTAREA" ||
   t.tagName === "SELECT" ||
   t.isContentEditable)
) return;
```

Also skip when `e.isComposing` (IME composition) and when any modifier key is held (`e.ctrlKey || e.metaKey || e.altKey`) so browser/system shortcuts still work.

Apply the same guard to `onKeyUp` so the movement state can't get stuck "pressed" if a key was first pressed inside an input and released elsewhere.

## Scope

- Single file: `src/components/inbox/TrackingStandby.tsx`
- No changes to game mechanics, power-ups, or UI.