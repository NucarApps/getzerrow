## Goal
Clicking blank space in the email list (below the last item, or in empty-state padding) should clear the currently selected message, collapsing the reader pane.

## Change
File: `src/routes/_authenticated/inbox.tsx`

On the scrollable list container (line 310, `<div className="flex-1 overflow-y-auto">`):
- Add `onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null); }}`

The `e.target === e.currentTarget` guard ensures clicks on email row buttons (which stop bubbling at the button itself by virtue of being the target) don't trigger deselection — only clicks that land directly on the empty scroll container will deselect.

## Out of scope
- No changes to the reader pane, keyboard handling, or selection state model.
- No styling changes.
