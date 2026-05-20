## Why reanalyze said "no change" for Jared

`jsmith@dcd.auto` is sitting in the **Cold Email** folder because Gmail has `Label_458` on it, and that label is mapped to the Cold Email folder (`folders.gmail_label_id = 'Label_458'`).

In `classifyParsedEmail` (`src/lib/sync.server.ts`), the order of checks is:

1. **Gmail label match** → if any folder's `gmail_label_id` is in `raw_labels`, classify as that folder. ✋ Wins here.
2. Inbox overrides (`inbox_overrides` table).
3. Folder filters / domain rules.
4. AI fallback.

You did add `dcd.auto` to `inbox_overrides` (confirmed in DB), but the Gmail-label check fires first, so the override never gets a chance. Reanalyze recomputes the same Cold Email folder → `folder_id` unchanged → "no change".

This is wrong: an explicit "always send to inbox" rule should beat an inherited Gmail label.

## Fix

In `src/lib/sync.server.ts` → `classifyParsedEmail`, move the **inbox overrides** check ahead of the Gmail-label check:

1. Compute `fromAddr` / `fromDomain`.
2. If any override matches → `folder_id = null`, `classified_by = "global_exclude"`, set `classification_reason`, skip AI. Return.
3. Otherwise fall through to the existing Gmail-label match → filters → AI flow (unchanged).

That's a ~15-line reorder inside one function. The existing reanalyze handler in `gmail.functions.ts` already strips the old folder's Gmail label when `folder_id` changes (via `modifyMessage(..., removeLabelIds: [fromLabel])`), so after the fix, hitting reanalyze on Jared will:

- Compute `folder_id = null` (override wins)
- Update the row to Inbox
- Remove `Label_458` from the Gmail message
- Toast `Re-analyzed → Inbox`

…and the email won't be reclassified back into Cold Email on next sync because the label is gone.

## Out of scope

- No change to the UI, the right-click menu, `addInboxOverride`, or `reanalyzeEmail`.
- No backfill: I won't auto-reprocess every existing email that matches an override. You'll trigger them individually via the reanalyze button (or we can add a "reapply overrides to all matching emails" action in a follow-up if you want).
- No change to the precedence between filters and Gmail labels — only overrides are being lifted above labels.
