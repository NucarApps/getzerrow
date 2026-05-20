## Goal

Hide the count badge on the "All mail" and "No rules" sidebar rows, while keeping the count on "All inbox" (which represents the inbox count).

## Change

In `src/routes/_authenticated.tsx`:

1. Update `FolderRow` props (line ~293, 300) — make `count` optional (`count?: number`) and only render the badge when `count` is a number > 0.
2. Remove the `count` prop from the "All mail" row (line ~227) and the "No rules" row (line ~234).
3. Leave the "All inbox" row (line ~220) and the user-folder rows (line ~244) untouched — both keep their counts.

No other files, no data/query changes — the underlying counts still compute, we just don't display them for those two rows.
