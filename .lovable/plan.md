## Goal

Stop the raw browser "Error" bar from appearing on an in-person recording (and any recording) when the media file can't play. Replace it with a clean, friendly fallback.

## Why it happens

In `src/routes/_authenticated/meetings.tsx`, when the recording's signed URL fails to load/decode, the native `<audio controls>` (or `<video>`) element shows the browser's own gray "Error" control. Our `onError` handler sets `videoError`, but:

- We never unmount the failed native player, so the "Error" chrome stays visible.
- The helpful message + Open/Download links sit inside a `Collapsible` that is collapsed by default on mobile, so on a phone the user only sees "Error".

## Changes (frontend only, one file)

`src/routes/_authenticated/meetings.tsx` — the `streamUrl` block (~lines 1057–1122):

1. When `videoError` is true, stop rendering the native `<audio>`/`<video>` element entirely so the browser's "Error" control disappears.
2. In its place, render a small, friendly card, e.g. "This recording couldn't be played in the browser." with the existing Open recording / Download buttons directly beneath it (always visible, not hidden behind the mobile collapsible).
3. Keep the normal (non-error) player and the collapsible Open/Download section exactly as they are for the success case.

No changes to server functions, storage, or the recording pipeline — this only fixes how a failed playback is presented.

## Verification

- Typecheck with `tsgo --noEmit`.
- In the preview, open the "Test" in-person meeting on mobile width and confirm the gray "Error" bar is gone, replaced by the friendly message plus Open/Download buttons.

## Note

This makes the failure look clean, but it does not repair the underlying file — that "Test" recording likely uploaded empty or corrupt. If you also want me to investigate why in-person recordings sometimes save an unplayable file (empty/short capture), say so and I'll add that as a follow-up.