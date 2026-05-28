# Pinpoint the exact rule that matched, even for tree-based folders

## Problem

The DocuSign email lives in the **Notifications** folder, which uses a rule **tree** (`OR` of `domain contains "docusign"` and `subject starts_with "Completed"`). Today, `src/lib/sync/classify.ts` only populates `emails.matched_filter_ids` when the folder uses flat filters — tree branches are skipped because tree leaves aren't rows in `folder_filters` and don't have IDs.

Result: the email's "why" panel can't pinpoint the rule, so it falls back to listing every rule in the folder.

## Fix (UI + tiny pure-logic helper, no DB changes)

The filter engine is pure logic and safe to import client-side. Re-evaluate the folder's tree against the email in the browser to extract just the matching leaves, and render those.

### 1. `src/lib/sync/filter-engine.ts`

Add one exported helper:

```ts
export function collectMatchingLeaves(
  email: EmailForFilter,
  node: RuleNode,
): Array<{ field: string; op: string; value: string }>
```

Walks the tree; for every `type: "cond"` leaf where `applyFilter(email, leafAsFilter)` returns true, collect `{field, op, value}`. Pure, no Supabase, fully unit-testable.

### 2. `src/routes/_authenticated/inbox.tsx` — `TriggeredBy` component (around line 1803)

- Extend the existing `useQuery(["folder-rules", folder_id])` to also select `filter_tree` from `folders` (it already loads the folder row).
- In the `useMemo` that computes `matched` (lines 1814–1827), add a third branch: when `classified_by === "filter"`, `matched_filter_ids` is empty, **and** the folder has a non-empty `filter_tree`, call `collectMatchingLeaves(email, filter_tree)` and render the returned leaves. These leaves have no `id`, so represent them as synthetic objects shaped like `{field, op, value}` (the list renderer at line 1840 already only reads those three fields).
- Only fall back to "showing all rules for this folder" when neither persisted IDs, recomputed includes, nor tree leaves yield anything.

### 3. (Optional, follow-up) Backfill new tree matches going forward

Not required for this fix, but worth a note: a later pass can update `src/lib/sync/classify.ts` to also persist matched leaf snippets in `classification_reason` (e.g. `Rule group matched for "Notifications": domain contains "docusign"`) so the why-panel has a server-rendered summary too. Out of scope for this change.

## Out of scope

- No schema migration (no new columns; matched_filter_ids stays as-is).
- No change to the sync/classification pipeline.
- No change to other classified_by branches (`ai`, `gmail_label`, `manual_move`, etc.).

## Files touched

- `src/lib/sync/filter-engine.ts` — add `collectMatchingLeaves`.
- `src/lib/sync/filter-engine.test.ts` — add a small unit test for the new helper.
- `src/routes/_authenticated/inbox.tsx` — extend folder query + `TriggeredBy` tree branch.
