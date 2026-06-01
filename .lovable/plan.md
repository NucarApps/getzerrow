## Goal

In the Contacts page **Groups** rail, make every contact-count badge (76, 54, 7, 11, 2, 5, …) align to the exact same vertical line, regardless of whether the row is a system row ("All contacts", "Ungrouped") or a user group with an edit pencil, and regardless of how many digits the count has.

## Why it's misaligned today

`GroupChip` (in `src/routes/_authenticated/contacts.index.tsx`, ~lines 495–531) lays each row out as:

```text
[ button: dot · label(flex-1) · countBadge ]  [ pencil OR placeholder ]
```

The count badge is the last child *inside* the flexible button, so its position depends on the button's width and the badge's own width. Combined with the badge using `min-w` + centered text, the badges don't end up on a single shared column across all rows.

## Fix

Refactor `GroupChip`'s internal layout to a fixed 4-zone row so the count always occupies its own right-aligned column:

```text
[dot] [label · flex-1, truncates] [count · fixed-width, right-aligned] [action · fixed 24px]
```

Concretely:
- Make the row a single flex container (keep the active/hover background and rounded styling).
- Keep the clickable area covering dot + label + count (so clicking the count still selects the group), but stop letting the badge float at the end of a `flex-1` button — instead give the count a fixed-width, right-aligned container (e.g. a consistent `w-9` / `min-w` box with `text-right` and `tabular-nums`) that is the same on every row.
- Always render the action zone as a fixed 24px slot: the pencil button for user groups, an empty placeholder of identical width for system rows (this part already exists and stays).
- Hide the badge box only when `count` is undefined, but still reserve its column width so rows without a count keep the same layout.

Net result: dot column, then a flexible truncating label, then a fixed count column whose right edge is identical on every row, then the fixed action column. All badges share one vertical line.

No data, server-function, or query changes — this is purely the presentation of the existing `GroupChip` component. `GroupPill` (the mobile horizontal-scroll variant) is left unchanged unless the same issue is visible there.

## Verification

- Visually confirm in the preview that 76 / 54 / 7 / 11 / 2 / 5 badges line up on the same right edge.
- Hover a user group to confirm the pencil appears without shifting the badge.
- Check a row with a 3-digit count (or simulate one) still aligns and doesn't clip the label.
