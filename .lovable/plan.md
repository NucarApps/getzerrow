# Fix: recording section eats all vertical space on mobile

## Problem
In the meeting detail slide-in panel (`src/routes/_authenticated/meetings.tsx`), the body is split into two competing regions:

```text
SheetHeader            (fixed)
┌ body ───────────────────────────┐
│ recording block  (natural height)│  ← player + error + Open/Download + "Recording status"
│ Tabs (flex-1, inner scroll)      │  ← Summary / Transcript squeezed into leftover space
└─────────────────────────────────┘
Footer                 (fixed)
```

On a phone the recording block's natural height is tall (player, red audio-only note, two buttons, three-line status box), so it pins to the top and leaves the Summary/Transcript tabs only a sliver to scroll in. That's the section in the screenshot taking up all the space.

## Fix (presentation-only)
Make the whole detail body one scroll column instead of a pinned block + inner-scrolling tabs. Then the recording section scrolls away naturally when the user reads the transcript/summary, and each tab uses the full width and height.

All changes are Tailwind class changes in `src/routes/_authenticated/meetings.tsx` — no logic, data, or component-structure changes.

1. **Body wrapper** (currently `flex min-h-0 flex-1 flex-col`): add `overflow-y-auto` so this single container owns the scroll.

2. **Recording + status block** (the `space-y-4 p-4 pb-3 sm:p-6 sm:pb-4` div): keep as-is; it now scrolls with the rest instead of being pinned.

3. **Tabs wrapper** (currently `flex min-h-0 flex-1 flex-col`): change to `flex flex-col` so it grows with content rather than fighting for leftover height.

4. **TabsList**: make it stick to the top of the scroll area while scrolling — add `sticky top-0 z-10 bg-background` (keep existing margins) so the Summary/Transcript switch stays reachable.

5. **Both TabsContent panels** (currently `min-h-0 flex-1 overflow-y-auto ...`): drop `min-h-0 flex-1 overflow-y-auto` and keep the padding/spacing, so content flows into the single outer scroller.

## Verification
- Re-check at 360px and 402px widths: the recording section no longer dominates; scrolling down reveals full-height Summary and Transcript, readable across the full width.
- Confirm desktop (`sm:` and up) still looks correct — header/footer fixed, body scrolls, tab switch stays visible.
- Note: this authenticated panel can't be fully rendered in the sandbox preview (no signed-in session), so final visual confirmation is best done in your live preview while signed in.
