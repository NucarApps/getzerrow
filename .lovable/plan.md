## Goal
Stop emails from rendering as a blank white box on first open. Currently a page refresh fixes it, which points at iframe lifecycle/timing in `EmailBodyFrame`.

## Likely causes
1. **Iframe reuse across emails.** When you switch from one email to another, React reuses the same `<iframe>` and just swaps `srcDoc`. In some browsers (especially mobile Safari) updating `srcDoc` on a live iframe doesn't reliably trigger a fresh load, so the previous frame's blank/old state sticks until the page reloads.
2. **`load` fires before the parent's `message` listener is attached.** The resize script posts height on `window.load`, but the parent's `useEffect` that listens for those messages runs after paint. The first (and sometimes only) height post is missed, leaving the iframe stuck at the 400px min and showing the email body's top whitespace only.
3. **Dark-mode email CSS overriding our light styles.** Some HTML emails ship `color:#fff` or `@media (prefers-color-scheme: dark)` rules. Combined with our white background, the text renders white-on-white. A refresh changes nothing visually, but combined with cause #2 it can look "blank until refresh" on certain messages.

## Plan
1. **Force a fresh iframe per email** in `src/routes/_authenticated/inbox.tsx`:
   - Add a `key` to `<EmailBodyFrame>` (and/or the inner `<iframe>`) tied to the selected email id so switching emails fully remounts the frame instead of mutating `srcDoc` on a live element.

2. **Fix the load/listener race** in `EmailBodyFrame`:
   - Attach the `message` listener with a `useLayoutEffect` (or register it before `srcDoc` is set) so the parent is always listening before the iframe can post.
   - In the in-iframe script, post height immediately (not only inside `window.addEventListener("load")`), plus on `DOMContentLoaded`, plus the existing `load`/timeout/ResizeObserver posts. This guarantees at least one height message after the parent is listening.
   - Also re-trigger a height request from the parent on mount via `iframe.onload`, as a belt-and-suspenders fallback.

3. **Neutralize dark-mode email CSS** in the `srcDoc` wrapper:
   - Add `color-scheme: light only` and a small reset that forces `color` and `background` on `body`/common wrappers so emails authored for dark mode don't render white-on-white inside our light frame.

4. **Validate on mobile (402x716)**:
   - Open several emails in a row (including the LOI thread in your screenshot) without refreshing and confirm the body renders the first time, every time.
   - Confirm desktop reader still renders and auto-sizes correctly.

## Out of scope
- No changes to sync, fetching, or how `body_html` is loaded — list rows already include `body_html`, so this is purely a render-timing fix in the reader component.
