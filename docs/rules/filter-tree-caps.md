# Task 3 — Filter-tree depth and leaf caps

ReDoS bounds (task 0, pre-existing) cap each _condition_; this task caps
the _tree_. A `filter_tree` with thousands of leaves — or absurd nesting —
is a DoS on the classify hot path, which runs for every folder on every
incoming email.

## Bounds (`src/lib/sync/filter-engine.ts`)

- `MAX_FILTER_TREE_DEPTH = 8` — nesting levels, root counts as 1.
- `MAX_FILTER_TREE_LEAVES = 128` — total `cond` nodes per tree.
- `validateRuleNode(node)` → `{ ok: true } | { ok: false; reason }` —
  checks structure (unknown node types, non-string cond fields, non-array
  children, bad group ops), depth, and leaf count. O(n) with early exit,
  and its depth check stops descending at the cap, so even a
  50 000-level-deep hostile tree can't blow the stack.

## Enforcement points

1. **Classify time** — `matchByFilters` validates a folder's tree before
   touching it (before `countConds`, which would otherwise recurse
   unboundedly). An out-of-bounds or malformed tree makes the folder
   **inert**: `evalNode` returns false, `collectMatchingLeaves` returns
   `[]`, and there is deliberately **no fallback to the flat
   `folder_filters`** — the tree superseded them, and stale flat filters
   silently taking over would misroute mail.
2. **Save time** — `FolderEditor.save()` (the code path that persists
   `filter_tree` in this repo — it writes via the RLS-scoped client, not a
   server fn as the task spec guessed) calls `validateRuleNode` and rejects
   the save with the validator's reason in a toast. Because classify-time
   enforcement is what actually bounds the hot path, a tree written around
   the editor (direct API call) gains nothing — it just never matches.

## Tests (`src/lib/sync/filter-engine.test.ts`)

Depth limit (8 ok / 9 rejected), leaf limit (128 ok / 129 rejected),
malformed nodes (unknown type, string children, numeric cond value, bad
group op), oversized tree never matches and never falls back to flat
filters, 50k-deep tree handled without evaluation, boundary-sized tree
still evaluates normally, `collectMatchingLeaves` short-circuit.
