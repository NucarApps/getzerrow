## Problem

The "Edit company" dialog (`CompanyAliasesDialog`) overflows the viewport on desktop and can't be scrolled — content like the "Other domains" section and footer buttons get clipped/hidden behind the screen edge.

The `<DialogContent>` currently has only `sm:max-w-md` with no height constraint or overflow handling, so when the body is taller than the viewport it just spills off-screen.

## Fix

In `src/components/contacts/CompanyAliasesDialog.tsx`, update the `<DialogContent>` to cap its height and scroll internally:

- Add `max-h-[90vh]` and `flex flex-col` to the `DialogContent`.
- Wrap the scrolling body section (the big `<div className="space-y-4">`) so it gets `flex-1 overflow-y-auto -mx-6 px-6` — letting the header and footer stay pinned while only the middle scrolls.
- Keep `DialogHeader` and `DialogFooter` outside the scroll area so Close / Delete merge always remain visible.

No logic, styling tokens, or other components change.

## Out of scope

- Mobile behavior (already works since the dialog fits).
- Any changes to the merge/tagging/logo features themselves.
