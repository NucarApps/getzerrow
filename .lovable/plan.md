## Problem

Clicking **Reanalyze email** on a cold email returned no AI match (`folder_name: "NONE"`), and the server function then wrote `folder_id: null` to the row. That moves the email into the **No rules** view, which surprised the user — they expected reanalyze to either improve the classification or leave it alone, never to strip an existing folder when the AI just couldn't decide.

## Root cause

`reanalyzeEmail` in `src/lib/gmail.functions.ts` (~lines 1011–1023) trusts `classifyParsedEmail`'s result unconditionally:

```ts
const result = await classifyParsedEmail(parsed, context.userId, email.gmail_account_id);
await supabaseAdmin.from("emails").update({
  folder_id: result.folder_id,           // ← becomes NULL when AI says NONE
  classified_by: result.classified_by,   // ← "ai"
  ai_confidence: result.ai_confidence,   // ← typically 0 / low
  ai_summary:    result.ai_summary || null,
  classification_reason: result.classification_reason,
  matched_filter_ids:    result.matched_filter_ids,
}).eq("id", email.id);
```

`classifyParsedEmail` returns `folder_id: null` when the AI replies `NONE` (see `src/lib/ai.server.ts:108–114`). The reanalyze handler then also runs the "folder changed" branch and calls Gmail `modifyMessage` to remove the previous folder's label.

## Fix

When reanalyze produces no folder match, treat it as a no-op for the row's assignment instead of clearing it.

### Change in `src/lib/gmail.functions.ts` — `reanalyzeEmail` handler

After computing `result` and before the DB update, detect the no-match case:

```ts
const noMatch =
  result.folder_id === null &&
  (result.classified_by === "ai" || result.classified_by === "none" || result.classified_by === "ai_error");

if (noMatch && email.folder_id) {
  // AI couldn't pick a better folder — keep the existing assignment untouched.
  // Still refresh ai_summary if we got one, but never strip folder_id / classified_by / Gmail label.
  await supabaseAdmin
    .from("emails")
    .update({
      ai_summary: result.ai_summary || null,
    })
    .eq("id", email.id);

  return {
    ok: true,
    folder_id: email.folder_id,
    folder_name: null,                       // caller doesn't use this when changed=false
    classified_by: "kept",
    classification_reason: "AI found no better folder — kept current assignment",
    changed: false,
  };
}
```

Then leave the rest of the handler unchanged. The existing `email.folder_id !== result.folder_id` branch keeps handling real moves (including null → folder and folder → different folder).

The `is_archived` flag is **not touched**, matching the user's preference to leave archived state alone.

### Optional UX touch in `_authenticated/index.tsx`

The "Reanalyze" button calls `reanalyzeEmail` and shows a toast. Add a small adjustment so the `changed: false` + `classified_by: "kept"` case shows a clearer message: e.g. `toast.message("No better folder — kept in <current folder name>.")`. Read the current folder name from `foldersQ.data` using `email.folder_id`. No new data fetches needed.

## Edge cases

- **Email had no folder to begin with** (`email.folder_id === null`) and AI returns NONE again: behavior unchanged — row stays with `folder_id: null` in No rules. Returning early would skip writing `classified_by`/`classification_reason`, so we still go through the normal update path in this case (the early-return guard requires `email.folder_id` to be truthy).
- **AI returns a different folder than current**: unchanged — the existing folder-change branch runs, Gmail labels swap, row updates.
- **AI returns the same folder**: unchanged — DB update writes the same `folder_id`, no Gmail label sync.
- **`classifyParsedEmail` returned a filter/label match (not AI)**: `classified_by` will be `"filter" | "domain_rule" | "gmail_label" | "global_exclude"` — none match the `noMatch` guard, so the row updates normally even if `folder_id` ends up null (e.g. a global inbox-override hit). That preserves filter-driven outcomes.

## Not changing

- `classifyParsedEmail` / AI prompt — the model is still allowed to say NONE; we just stop letting NONE wipe a known-good assignment.
- Archive / INBOX state.
- The initial classification on ingest (where there's no prior folder to protect).
- Schema or migrations.

## Verification

1. Open a cold email currently in a folder (e.g. Cold Outreach), click **Reanalyze**.
2. Confirm the toast says it kept the current folder and the email remains in that folder's list — does NOT appear in **No rules**.
3. Open an email AI should re-route to a different folder, click **Reanalyze**, and confirm the move still happens with the Gmail label swap.
