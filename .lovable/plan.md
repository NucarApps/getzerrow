
# Goal

A newly created folder should do **nothing** — no AI classification, no filing — until the user explicitly gives it rules (filter tree) or an AI prompt (`ai_rule`). Linking a Gmail label just mirrors what Gmail already labeled; it does not authorize Zerrow to invent new matches.

This replaces my earlier "mirror-only when linked to existing label" heuristic, which was wrong because the default "Create new Gmail label" path also sets `gmail_label_id` and would have incorrectly disabled AI on every fresh folder.

# The rule

A folder is "active" for classification only if at least one is true:
- It has a non-empty `filter_tree` (user-authored rules), **or**
- It has a non-empty `ai_rule` (user-authored AI prompt).

Otherwise it's inert:
- Gmail-labeled mail still lands in it (that's Gmail, not Zerrow).
- Manual moves still work and still teach the learned profile.
- The classifier does **not** consider the folder — no rule match attempts, no AI profile match, regardless of `learned_profile` or `min_ai_confidence`.

# Changes

## 1. Create defaults — `src/lib/gmail/folder-mgmt.functions.ts`

Replace `deriveFolderAiDefaults` with a single default applied to every new folder regardless of label linkage:

- `skip_ai: true`
- `min_ai_confidence: 0.75`
- `filter_tree: null`
- `ai_rule: null`

`learned_profile` is still populated on label-link (via `learnFromLinkedLabel`) so it's ready the moment the user opts in — but `skip_ai=true` keeps it dormant.

Update the unit test in `src/lib/gmail/folder-mgmt.defaults.test.ts` to assert the same defaults for both linked and unlinked folders.

## 2. Classifier gate — `src/lib/sync/classify.ts` (and/or `process-message.ts` where folders are enumerated)

Add an "is folder active" check before the folder is considered for matching:

```ts
const isActive =
  (folder.filter_tree && hasConditions(folder.filter_tree)) ||
  (folder.ai_rule && folder.ai_rule.trim().length > 0);
if (!isActive) continue;
```

This is the real safety net — even if a legacy folder still has `skip_ai=false` and a `learned_profile`, it won't classify unless the user has added rules or an AI prompt. Manual moves and Gmail-label routing (which happen before the classifier) are untouched.

## 3. Auto-enable when the user adds intent — `EditFolderDialog` save path

When a folder transitions from inert → having a `filter_tree` or `ai_rule` for the first time, flip `skip_ai=false` automatically so the user's newly added AI prompt actually runs. Rules-only folders can stay `skip_ai=true`.

Implemented as a small helper in `folder-mgmt.functions.ts` called from the update server fn — no UI change required.

## 4. Backfill for existing users

One-shot migration or `supabase--insert` to set `skip_ai=true` and `min_ai_confidence=0.75` on every folder that currently has:
- empty/null `filter_tree`, **and**
- empty/null `ai_rule`

This retroactively fixes Jared's "Kenect Reports" situation for anyone else in the same shape. Users who already authored rules or an AI prompt are left alone.

## 5. Reclassify affected mail

For every folder the backfill touched, find emails filed with `classified_by='ai'` where the folder is now inert, null their `folder_id`, and requeue as `classify` jobs — same shape as the one-off cleanup we already ran for Jared.

## 6. Tests

- `folder-mgmt.defaults.test.ts` — every new folder starts inert (`skip_ai=true`, no rules, no ai_rule).
- New test in `src/lib/sync/classify.test.ts` (or nearest existing) — a folder with `learned_profile` but no `filter_tree`/`ai_rule` is skipped by the classifier even with `skip_ai=false`.
- New test — a folder gets `ai_rule` added; the update path flips `skip_ai=false`.

# Out of scope

- No classifier model changes.
- No UI copy changes in `AddFolderDialog` — the current label-link flow keeps working, it just doesn't auto-classify anymore.
- No changes to `learnFromLinkedLabel` — the profile is still learned in the background so activation is instant when the user opts in.
