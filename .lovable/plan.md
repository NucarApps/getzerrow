# Fix inbox not filling height on mobile

## Problem
On mobile, the inbox list stops after the visible emails and the "Page 1" footer floats up, leaving a large empty area below it.

## Cause
`src/routes/_authenticated/inbox.tsx` line 524 wraps the two panels in:

```
<div className="grid h-full min-h-0 md:grid-cols-[400px_1fr]">
```

On mobile there's no `grid-cols`/`grid-rows` set, so grid auto-rows size each child to its content. The list panel's `h-full` then resolves against an auto-sized row and collapses — so `flex-1` on the inner list never fills the viewport, and the pagination bar sits right under the last email.

## Fix
Make the container stretch its single visible child to full height on mobile, while keeping the existing 2-column desktop layout.

Change line 524 to use flex on mobile, grid on desktop:

```
<div className="flex h-full min-h-0 flex-col md:grid md:grid-cols-[400px_1fr]">
```

That's the only edit — both panels already use `h-full min-h-0` and the correct hidden/visible classes, so the desktop grid behavior is unchanged.

## Verification
- Mobile: list fills viewport, pagination bar pinned to bottom of the list panel above the Safari toolbar.
- Mobile reader: opening an email still shows the reader full-height (it also has `h-full`).
- Desktop (`md+`): unchanged 400px + 1fr two-pane layout.
