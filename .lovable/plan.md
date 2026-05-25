## Problem

On mobile the email detail's classification trigger just shows the generic text "Why this folder?" — the actual destination folder (color dot + name) isn't visible until you expand. The `ClassifiedChip` is also hidden on small screens (`hidden sm:inline-flex`).

## Change

Edit only the `CollapsibleTrigger` in `src/routes/_authenticated/inbox.tsx` (around line 1484–1494) so the trigger surfaces the actual folder as a chip:

- Look up the email's current folder from the in-memory `folders` list using `email.folder_id`.
- If a folder is found, render a chip on the trigger with the folder color dot + truncated folder name (matching the "Also matched" chip style already used below at lines 1517–1524 for visual consistency).
- Keep the `HelpCircle` icon and a short prefix label ("In") so the question framing is preserved; drop the long "Why this folder?" text on mobile to make room — show it only on `sm:` and up.
- Keep the `ClassifiedChip` (ai / filter / gmail_label etc.) visible alongside the folder chip on all viewports, not just `sm`, so users can tell *how* it landed there at a glance.
- If `email.folder_id` is null (unclassified / inbox), fall back to the existing "Why this folder?" label.
- Chevron stays on the right and continues to rotate on open.

No business logic, no data fetching, no styles outside this trigger. Expanded `CollapsibleContent` is unchanged.

## Files

- `src/routes/_authenticated/inbox.tsx` — trigger block only.
