## Goals
1. Scrollbars render in the app's dark theme instead of the light OS default.
2. The empty gap to the right of the contact detail pane on wide desktop screens is gone — the detail pane grows to fill it.

## Changes

### `src/styles.css` — dark scrollbars
- In `:root` (and inside `@layer base` for `html, body`), set `color-scheme: dark;` so native scrollbars in Chrome/Safari/Firefox pick the dark variant automatically.
- Add a small WebKit fallback so scrollbars visibly match the palette on macOS overlay-off setups:
  ```css
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb {
    background: color-mix(in oklab, var(--foreground) 18%, transparent);
    border-radius: 6px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: color-mix(in oklab, var(--foreground) 28%, transparent);
  }
  ::-webkit-scrollbar-track { background: transparent; }
  ```

### `src/routes/_authenticated/contacts.index.tsx` — remove empty gap
- The right-hand detail `<aside>` (line 1398) currently uses `w-[clamp(420px,42vw,640px)] shrink-0`, so on wide screens (list capped at 720px + aside capped at 640px) any extra viewport width becomes empty background.
- Change the aside to grow: `flex-1 min-w-[420px] xl:flex` (drop the fixed clamp width and drop `shrink-0`). Keep `border-l border-border bg-card/30`.
- Result: on ≥xl the list stays at its 720px cap and the detail pane consumes all remaining width, so there is no dead space to the right.

No changes to data, routing, or business logic.