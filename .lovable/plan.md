## Fix multi-select checkbox on "No rules"

**Root cause:** The `<Checkbox>` sits inside a wrapping `<button>` row, plus its `onClick` parent span calls `toggleCheck()` while Radix's `onCheckedChange` also calls it — they double-fire and net to no change. Nested interactive elements also make Radix swallow the event in some browsers.

**Fix (in `src/routes/_authenticated/inbox.tsx`):**

1. Remove the `onClick` + `stopPropagation` from the wrapper `<span>` around the Checkbox; let only `onCheckedChange` toggle.
2. Change the row container from `<button>` to a `<div role="button">` when `isNoRules`, so the Checkbox isn't nested inside a button.
3. Keep the row's own click handler that toggles selection when `isNoRules` (so clicking anywhere on the row still toggles), but make the Checkbox area `pointer-events: auto` and stop event propagation only at the Checkbox itself via a wrapping `<div onClick={(e) => e.stopPropagation()}>` so the row handler doesn't double-fire with it.

Net behavior: clicking the checkbox toggles once; clicking elsewhere on the row also toggles once.
