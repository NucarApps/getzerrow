## Goal

Make the AI-assigned category and the rule that placed each email visible at a glance in the inbox list, and make correcting it a one-click action — without rebuilding what already works in the detail pane.

## What's already there (keeping as-is)

- **Detail pane** (per email): folder pill, "Why this folder?" collapsible with the classifier badge (`ai`, `filter`, `domain_rule`, `gmail_label`, `global_exclude`, `manual_move`, etc.), the human-readable `classification_reason`, AI confidence bar, "Move similar", "Always inbox", "Reanalyze", and "Remove folder label from past emails".
- **Backend**: `classified_by`, `classification_reason`, `matched_filter_ids`, `ai_confidence` are already written by `sync.server.ts` for every email.

## What this plan adds

### 1. Show the rule on every list row

In `src/routes/_authenticated/inbox.tsx`, on each list row, add next to the folder pill:

- A small `ClassifiedChip` (already exists — reuse it) so users see *how* it was categorised: AI, Filter, Domain, Gmail label, Manual, Excluded.
- The first ~60 chars of `classification_reason` as muted text under the chip, truncated with `line-clamp-1`. Full text on hover via `title`.
- Show the folder pill on **all** views (not only "all"/"all_mail"/"no_rules") so the row always tells you where it landed.

### 2. Quick-correct action on the row

Add a tiny "Wrong?" affordance on each row (icon-only, shows on hover) that opens a popover with:
- Move to a different folder (folder picker, same logic as existing context menu)
- Move to inbox (no folder)
- "Reanalyze with AI"

This duplicates context-menu actions but makes them discoverable without right-click. No new server functions — wires straight into the existing `moveEmailToFolder`, `moveEmailToInbox`, `reanalyzeEmail`.

### 3. Open the "Why" panel by default

Default `whyOpen` to `true` in the detail pane so the rule is visible without an extra click. User can still collapse it.

## What this plan does NOT change

- No schema changes — all fields exist.
- No new server functions — corrections already work.
- No changes to classification logic in `sync.server.ts`.
- No changes to settings/folders pages.

## Files touched

- `src/routes/_authenticated/inbox.tsx` — list row rendering, default `whyOpen=true`, small inline "Wrong?" popover. ~60 lines changed/added.

## Result

- Scanning the inbox: each row shows `[Folder pill]` `[AI / Filter / Domain chip]` with a one-line reason. No clicks required.
- Correcting a mistake: hover a row → click "Wrong?" → pick the right folder, or click reanalyze. Two clicks instead of right-click → submenu.
- Detail view: the rule is open by default, so the reason and confidence are immediately visible.