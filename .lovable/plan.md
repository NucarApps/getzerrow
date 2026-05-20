# Fix: Reanalyze quietly removed email from its folder

## What's happening

In `reanalyzeEmail` (`src/lib/gmail.functions.ts` ~L1033) the "keep current folder" guard only fires when `result.classified_by` is `ai`, `none`, or `ai_error`:

```ts
const noMatch =
  result.folder_id === null &&
  (result.classified_by === "ai" ||
   result.classified_by === "none" ||
   result.classified_by === "ai_error");
```

But `classifyParsedEmail` (`src/lib/sync.server.ts`) can also return `folder_id: null` with:

- `classified_by: "excluded"` — when a filter on some folder matched an *exclude* rule, suppressing AI.
- `classified_by: "global_exclude"` — when the sender is on the global inbox-override list, also suppressing AI.

Both cases fall through the guard and hit the main `update({ folder_id: result.folder_id, ... })` at L1054, which **overwrites the email's existing folder_id to null**. The email then disappears from the Cold Email folder view, while the detail panel still shows the old folder until React Query refetches that single row.

This matches the reported symptom: reanalyzing Hannah Sullivan's email removed it from Cold Email, but opening it via search still showed Cold Email as the folder.

## The fix

Make the "keep current folder" behavior unconditional whenever the classifier returns no folder and the email already has one. Reanalyze should only ever *move* an email to a better folder — never silently un-classify it.

### `src/lib/gmail.functions.ts` — `reanalyzeEmail` (~L1033–1051)

Replace the narrow `noMatch` check with a simpler rule:

```ts
// If the classifier didn't pick a folder and the email already has one,
// keep the current assignment regardless of WHY the classifier abstained
// (AI no-match, excluded by rule, global override, etc.). Reanalyze should
// only move emails to a better folder, never silently clear them.
if (result.folder_id === null && email.folder_id) {
  await supabaseAdmin
    .from("emails")
    .update({ ai_summary: summary || null })
    .eq("id", email.id);
  return {
    ok: true,
    folder_id: email.folder_id,
    folder_name: null,
    classified_by: "kept",
    classification_reason:
      result.classification_reason ||
      "Classifier found no better folder — kept current assignment",
    changed: false,
  };
}
```

Everything else (the main update path, the folder-change Gmail label sync, the unchanged-folder return) stays exactly as is.

### Toast (no change needed)

`src/routes/_authenticated/index.tsx` already handles `classified_by === "kept"` with the friendly "No better folder — kept in &lt;folder&gt;." message, so the user gets clear feedback instead of a misleading "no change" while the row vanishes.

## Out of scope

- Initial ingest (`processGmailMessage`) — unchanged. First-time classification should still respect excludes/overrides and leave the email in the Inbox.
- Classifier logic in `sync.server.ts` — unchanged.
- Schema, migrations, Gmail label sync — unchanged.

## Verification

1. Open Cold Email folder, find Hannah Sullivan, click Reanalyze.
2. Expect: toast says "No better folder — kept in Cold Email." and the row stays put with a fresh ✨ summary.
3. Open the email — folder badge still shows Cold Email.
4. Reanalyze an email where the AI actually picks a different folder — confirm it still moves and shows "Re-analyzed → &lt;folder&gt;".
