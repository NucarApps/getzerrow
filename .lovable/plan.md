## Goal

Two related fixes for misclassified emails:

1. **Re-analyze**: re-run the full classification pipeline (overrides → Gmail label → filters → AI) on an existing email, so it picks up changes you made to folders/rules/overrides after it landed.
2. **Move to plain Inbox**: explicit "no folder, no rule" destination — plus the option to add the sender to "Always send to inbox" so future mail from them also skips folders.

Today the only way out of a wrong folder is into another folder (`moveEmailToFolder` requires a target UUID). There's no way to unfile an email, and there's no way to ask the system "look at this again."

## Changes

### 1. Server function: `reanalyzeEmail` (new, in `src/lib/gmail.functions.ts`)

- Input: `{ email_id }`.
- Loads the email row + the user's folders, filters, and overrides.
- Reuses the existing classification logic from `sync.server.ts` — the cleanest path is to extract the override/filter/AI cascade (lines ~191–248) into a `classifyParsedEmail()` helper in `src/lib/sync.server.ts` and call it from both the sync path and the new server fn.
- Updates the email row with the new `folder_id`, `classified_by`, `ai_confidence`, `ai_summary`, `classification_reason`, `matched_filter_ids`.
- Best-effort Gmail label sync: remove the old folder's `gmail_label_id`, add the new one (mirrors `performMove`).
- Returns `{ folder_id, classified_by, classification_reason }` so the UI can toast it.

### 2. Server function: `moveEmailToInbox` (new, in `src/lib/gmail.functions.ts`)

- Input: `{ email_id, add_override?: "email" | "domain" | null }`.
- Sets `folder_id = null`, `classified_by = "manual_inbox"`, `classification_reason = "Moved to Inbox manually"`.
- Removes the old folder's `gmail_label_id` from the Gmail message; ensures `INBOX` label is present (in case auto-archive moved it out).
- Deletes any `folder_examples` row for this message so the AI doesn't keep training on the mistake.
- If `add_override` is set, upserts an `inbox_overrides` row for `from_addr` (email) or its domain. Skips silently if the value already exists.
- Returns `{ from_addr, domain, override_added }`.

### 3. UI: Reader actions (`src/routes/_authenticated/index.tsx`)

In the existing action bar next to Move/Archive/Trash:

- **Add a "Re-analyze" button** (Sparkles or RotateCw icon). On click: optimistic spinner, call `reanalyzeEmail`, toast the result (e.g. "Re-analyzed → Cold outreach" or "Re-analyzed → Inbox"), invalidate `["emails"]`.
- **Add "Inbox (no folder)" as the first item in the Move dropdown**, separated from the folder list. Clicking it calls `moveEmailToInbox` (no override) and shows a follow-up dialog (reuses the pattern of `MoveSimilarDialog`) asking:
  - "Always send mail from `jared@dcd.auto` to inbox?" → calls again with `add_override: "email"`.
  - "Always send mail from `dcd.auto` to inbox?" → calls again with `add_override: "domain"`.
  - "No thanks" → closes.

The dialog is a new tiny component `src/components/emails/AlwaysInboxDialog.tsx` mirroring `MoveSimilarDialog`. It only renders if `from_addr` is present.

### 4. Refactor inside `src/lib/sync.server.ts`

Extract the classification cascade (the block currently at lines ~181–248) into:

```ts
export async function classifyParsedEmail(parsed, userId, accountId): Promise<{
  folder_id: string | null;
  classified_by: string;
  ai_confidence: number;
  ai_summary: string;
  classification_reason: string | null;
  matched_filter_ids: string[];
}>
```

Have both `processMessage` (sync) and the new `reanalyzeEmail` server fn call it. No behavior change to the sync path.

## What I'm NOT changing

- `moveEmailToFolder` keeps requiring a UUID — moving to a real folder still goes through it.
- The "move similar" prompt for folder→folder moves stays as-is.
- DB schema, RLS, and the realtime hook (already in place from the last turn — re-analyze results will propagate automatically).

## Files

- `src/lib/sync.server.ts` — extract `classifyParsedEmail`, swap `processMessage` to use it.
- `src/lib/gmail.functions.ts` — add `reanalyzeEmail` + `moveEmailToInbox` server fns.
- `src/components/emails/AlwaysInboxDialog.tsx` (new) — follow-up "always send to inbox?" prompt.
- `src/routes/_authenticated/index.tsx` — Reader gets a Re-analyze button + "Inbox (no folder)" move option + dialog wiring.
