## Problem

On mobile, the email body renders as a small blank white box. Both symptoms have the same root cause in `EmailBodyFrame` (`src/routes/_authenticated/inbox.tsx`, lines ~98–131).

The iframe uses `srcDoc` with `sandbox="allow-popups allow-popups-to-escape-sandbox"` — no `allow-same-origin`. Per the HTML spec (and enforced strictly by iOS Safari), a sandboxed iframe without `allow-same-origin` runs in an opaque origin, so the parent cannot read `iframe.contentDocument`. The `onLoad` resize handler does `f.contentDocument.documentElement.scrollHeight`, which throws / returns null on mobile → resize bails out → the iframe stays at the browser default (~150px) showing only blank white space. On desktop Chrome this sometimes works due to looser handling, masking the bug.

Adding `allow-same-origin` would fix sizing but is unsafe for arbitrary third-party email HTML (it would gain access to the app's localStorage, cookies, IndexedDB).

## Fix

Switch to an **inside-out resize**: inject a tiny script inside the `srcDoc` that measures its own body and `postMessage`s the height to the parent. The parent listens for that message and sets the iframe height. This works without `allow-same-origin`, so security is preserved.

### Changes to `EmailBodyFrame` only

1. Add `allow-scripts` to the sandbox attribute (still no `allow-same-origin`, so the frame remains in an opaque origin with no access to app storage/cookies).
2. Inside `srcDoc`, append a `<script>` that:
   - Generates a random `frameId` (also passed in via a query-string-style token in the script).
   - On load, on `ResizeObserver(body)`, on every `<img>` load, and on `window.resize`, calls `parent.postMessage({ __zerrowFrame: frameId, height }, "*")` with `document.documentElement.scrollHeight`.
3. In the React component:
   - Generate a stable `frameId` per mount (`useId()`).
   - Pass it to the script via the srcDoc string.
   - Add a `useEffect` that listens for `message` events, filters by `__zerrowFrame === frameId`, and sets the iframe height (clamped 200–4000px).
   - Remove the `onLoad`-based contentDocument reads.
4. Bump the loading minHeight from `60px` to `400px` so the pane is usable while the first message arrives (eliminates the "window too small" feel even on slow first paint).
5. Keep the existing inline CSS reset (margins, viewport meta, img max-width, etc.).

### Files touched

- `src/routes/_authenticated/inbox.tsx` — replace the `EmailBodyFrame` component (~lines 87–131). No other code paths change.

### Security note

`allow-scripts` without `allow-same-origin` is the standard pattern used by Gmail/Superhuman/Hey for rendering untrusted email HTML. The frame can run its own JS but cannot read parent cookies, localStorage, or the DOM — only `postMessage` to the parent, which we validate by `frameId`.

### Verification

- Open an HTML email on mobile preview → body renders with full height, no blank white box.
- Open the same email on desktop → still renders correctly, height matches content.
- Inspect: iframe sandbox = `allow-popups allow-popups-to-escape-sandbox allow-scripts` (no `allow-same-origin`).
