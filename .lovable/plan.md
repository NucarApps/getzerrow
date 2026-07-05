# Mobile: hide the "Recording status" card, keep only a refresh button

## Problem
In the meeting detail panel (`src/routes/_authenticated/meetings.tsx`, the `meeting.status === "done"` block ~line 1107), the "Recording status" card shows a heading, a "Recording found · Transcript found · Summary found" line, and a refresh button. On mobile this card is unnecessary clutter — the user only wants a way to refresh.

## Fix (presentation-only)
On mobile, drop the card chrome and status text entirely and render just the refresh control. On `sm` and up, keep the full card exactly as-is.

All changes are Tailwind class changes in the same block — no logic changes.

1. **Card wrapper** (`rounded-md border border-border bg-muted/30 p-3 text-sm`): make the border/background/padding apply only at `sm:` so on mobile it's a plain, chrome-less container (`max-sm:` resets border, bg, padding).
2. **Status text group** (the `space-y-1` div with "Recording status" heading + the found/not-found line): add `max-sm:hidden` so heading and status line don't render on mobile.
3. **Refresh button**: keep it visible on all sizes. On mobile it becomes the only thing in this block. Keep the current icon-only treatment on mobile (spinning icon, accessible label) and the labelled button on `sm+`. Align it left on mobile since there's no adjacent text.
4. **Recording error** (`recordingError` paragraph): keep rendering on all sizes so failures are still surfaced.

## Result
- Mobile: no "Recording status" card — just the refresh button (and any error message if present).
- Desktop (`sm+`): unchanged full status card with heading, status line, and labelled refresh button.

## Verification
- Check at 360px / 402px: only the refresh button shows where the card used to be.
- Check `sm+`: full card intact.
- Note: this authenticated panel can't be fully rendered in the sandbox preview (no signed-in session), so final confirmation is best in your live preview while signed in.
