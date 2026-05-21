## Mobile email view cleanup

Two problems visible in the screenshot:
1. The action toolbar overflows at 402px — Reply + 6 icon buttons + AI badge don't fit, so Reply overlaps the resync icon.
2. The subject renders ~6 lines tall for long forwarded subjects, eating the screen.

### Changes to `src/routes/_authenticated/inbox.tsx`

**1. Toolbar (lines 705–849)** — make it fit on mobile
- Hide the `AI · NN%` badge on mobile (line 713–715): add `hidden md:inline-flex`. Same info is in the Summary card below.
- Hide the folder badge on mobile when `onBack` is shown (line 712): add `hidden md:inline-flex`. Folder is implied by the list you came from.
- Shrink ghost icon buttons on mobile to `h-8 w-8 p-0` (reanalyze, move, mark-read, archive, trash, resync).
- Reduce gap on mobile: `gap-1` → `gap-0.5`.
- Reply button stays prominent but compact: `h-8 px-2.5`.
- Safety net: add `flex-nowrap overflow-x-auto` on the right-side button row so anything still tight scrolls instead of overlapping.

**2. Subject (line 854)** — cap height on mobile
- `text-xl md:text-2xl` → `text-lg md:text-2xl`.
- Add `line-clamp-3 md:line-clamp-none` so long forwarded subjects stop eating the screen.

**3. Sender line (lines 855–859)** — drop the `<addr>` on mobile
- Wrap the `<…@…>` portion in `<span className="hidden md:inline">`.
- Mobile shows: `Alyssa Quinn · 5/20/26, 1:27 PM`.

**4. "Why this folder?" trigger (lines 867–877)**
- Hide the `ClassifiedChip` on mobile (`hidden sm:inline-flex`) so the row stays single-line.
- Make the label span `min-w-0 flex-1 truncate`.

### Result
- Toolbar fits cleanly at 390–414px; Reply no longer overlaps.
- Subject capped at 3 lines on mobile (~half the height).
- Header block ~40% shorter on mobile, desktop unchanged.

No business logic changes.