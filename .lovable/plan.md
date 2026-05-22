## Goal
Polish the new Contacts section so every page works well on a narrow phone viewport (≈375–414px). All four routes use a `md:` breakpoint already, so most fixes are surgical CSS-only.

## Scope
Frontend only, four route files:
- `src/routes/_authenticated/contacts.tsx` (list + groups rail)
- `src/routes/_authenticated/contacts.$id.tsx` (detail)
- `src/routes/_authenticated/contacts.scan.tsx` (scan card)
- `src/routes/_authenticated/my-card.tsx` (own card editor)

No logic, server-function, or schema changes.

## Issues found and fixes

### 1. `contacts.tsx` — Groups rail dominates mobile
On phones the 2-col grid collapses and the vertical group list pushes the contact list way down the page.

Fix:
- Below `md`, render groups as a horizontally scrollable pill row (snap chips, hidden scrollbar) sitting just under the header. Keep the vertical sidebar at `md+`.
- "New group" becomes a trailing `+` pill at the end of the scroll row on mobile.
- Edit (pencil) on a group: long-press is overkill — keep desktop hover affordance, and on mobile show pencil inline (always visible) only when that group is active.

### 2. `contacts.tsx` — Header buttons cramp on small screens
"My card / Scan card / Refresh" wrap to a second line and look noisy.

Fix:
- Hide button text on `<sm` (icon-only), keep `aria-label`/`title`. Reduce header gap.
- Subtitle "N people" stays.

### 3. `contacts.$id.tsx` — Action bar + group chips
The Re-enrich / Send / Delete row is fine via `flex-wrap` but Delete with `ml-auto` jumps to a new line awkwardly on phone.

Fix:
- On mobile, Delete drops to its own right-aligned row; on `sm+` keep current layout.
- Group chip row already wraps — ensure container allows wrap and chips don't overflow (add `min-w-0` where needed).

### 4. `contacts.scan.tsx` and `my-card.tsx`
Already responsive (`sm:grid-cols-2`, stacks on mobile). Minor pass:
- Ensure preview image and QR card don't overflow on 360px widths (`max-w-full`).
- `my-card` action row: wrap-friendly, keep buttons full-width-stacking on `<sm`.

## Out of scope
- Group rail redesign for tablet
- Any change to colors, fonts, or design tokens
- Bottom-nav or app-shell changes (those live in `_authenticated.tsx`)

## Verification
After edits, view contacts list, detail, scan, and my-card at 390×844 in the preview and confirm: no horizontal scroll, header fits one row, groups reachable in one tap, all forms usable.
