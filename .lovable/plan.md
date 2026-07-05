# Mobile responsiveness pass — Meetings page

## Problem
On phones the meetings surfaces use desktop-sized padding and headings, so sections feel oversized and the summary/transcript reading areas get squeezed and hard to read. All changes are presentation-only (Tailwind classes), no logic changes.

Files touched:
- `src/routes/_authenticated/meetings.tsx`
- `src/components/meetings/UpcomingMeetingsCard.tsx`

## 1. Meeting detail panel (slide-in sheet)
The sheet is the worst offender — every block uses fixed `p-6`, eating horizontal and vertical space so transcript/summary barely fit.

- Change section padding from `p-6` to responsive `p-4 sm:p-6` on: the header, the body block, the summary tab, the transcript tab, and the footer.
- Header title: scale down on mobile (e.g. `text-base sm:text-lg`) and keep truncation so long titles don't push the badge off-screen.
- Recording-status block and the in-progress refresh row: allow the button to wrap under the text on narrow widths instead of competing for space.
- Ensure the tab content region keeps `flex-1 min-h-0 overflow-y-auto` so the transcript/summary scroll within the sheet and use the full available height.
- Transcript readability: keep line text at a comfortable size with slightly looser line spacing (`leading-relaxed`) and reduce inner container padding on mobile so more of each line is visible.

## 2. Record dialogs (Record a meeting / Record in person / Screen record)
- Reduce the inner recording box padding from `p-6` to `p-4 sm:p-6`.
- Make dialog content comfortably fit a phone (respect viewport width with a small margin, scroll body if content is tall).
- Confirm the action buttons stay full-width on mobile (already `w-full sm:w-auto`) and stack cleanly.

## 3. Upcoming meetings card
- Scale the `text-2xl` heading down on mobile (`text-lg sm:text-2xl`) and tighten the header padding.
- List rows: keep the title truncating (`min-w-0`) and let the "Send notetaker" label hide on the smallest widths (show the switch only), so the toggle and title don't collide.

## 4. Past meetings list + page headers
- Scale the page `text-2xl` title responsively and reduce top/section padding slightly on mobile.
- Verify list cards don't cause horizontal overflow at 360–402px widths.

## Verification
- Re-check at 360px and 402px widths (mobile) and at `sm`/desktop to confirm no regressions.
- Confirm no horizontal page scroll and that summary + transcript are comfortably readable with the detail panel open.

## Technical notes
- Pure Tailwind class adjustments using semantic tokens; no changes to server functions, data flow, or component structure.
- Authenticated views (list, detail, upcoming) can't be fully rendered in the sandbox preview (no signed-in session), so final visual confirmation of those areas is best done in your live preview while signed in.
