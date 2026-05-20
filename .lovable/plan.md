## Problem

The console error `jizDREVItHgc8qDIbSTKq4XKVUIZAZHwO5dxhxz3hg.woff2: 404` comes from `src/styles.css`, which hardcodes a `v4` Instrument Serif woff2 URL on `fonts.gstatic.com`. Google has since bumped the family to `v5`, so the old URL now returns 404. Curling Google Fonts confirms the current asset is `v5/jizBRFtNs2ka5fXjeivQ4LroWlx-2zI.ttf`.

While a font 404 alone shouldn't blank the page (the SSR'd HTML for `/login` renders correctly when I fetch it), pinning a hashed font path is fragile — any future Google version bump will break it again.

## Fix

In `src/styles.css`, replace the hardcoded `@font-face` block with a Google Fonts stylesheet import, which always resolves to the current version:

```css
@import url("https://fonts.googleapis.com/css2?family=Instrument+Serif&display=swap");
```

Remove the existing `@font-face { font-family: "Instrument Serif"; src: url(...v4....woff2)... }` block inside `@layer base`. The `--font-display` token and all `font-display` class usages stay unchanged.

## Verification

After the edit:
1. Reload the preview and confirm no 404 in the console.
2. Confirm the "Zerrow" wordmark on `/login` still renders in the serif display face.

## Files

- `src/styles.css` — swap hardcoded `@font-face` for Google Fonts `@import`.
