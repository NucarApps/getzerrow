# What the screenshot actually shows

Jared re-created the folder after the earlier grants fix landed. It exists in the DB now (`folder_id 50e9ea60…`, linked to Gmail `Label_27`) and the banner at the top is his 6-month backfill still running (55,530 / 55,656).

Current contents of Kenect Reports = 105 emails, decided by:

| Source | Count | Notes |
|---|---|---|
| `gmail_labeled` / `gmail_label` | 72 | Already labeled `Label_27` in Gmail — Zerrow correctly followed the label. |
| `manual_move` | 24 | Jared moved them himself. |
| `ai` | **9** | Matched Zerrow's *learned profile* for the folder, **without** a Gmail label and **without** any user-authored rule. |

So the "emails going into it that make no sense" are the **9 AI-classified rows**. The folder has:

- `filter_tree`: empty
- `ai_rule`: empty
- `learned_profile`: **auto-populated** (linking a Gmail label triggers `learnFromLinkedLabel`, which learns from historical labeled mail — mostly dealer / auto-industry senders in his case, so the profile is broad enough to catch adjacent mail)
- `min_ai_confidence`: **0** (accepts any AI match)
- `skip_ai`: **false**

That combination is the root cause: a label-linked folder with no explicit user intent still competes for every incoming email via the learned profile at zero confidence floor. This is the default across the app, not specific to Jared.

# Plan

## 1. Product fix — safer defaults for label-linked folders

Change `createFolder` (already the new server function) so that when the user picks **"Link to existing Gmail label"** (i.e. `gmail_label_id` is provided at creation), the folder starts as **label-only**:

- `skip_ai = true`
- `min_ai_confidence = 0.75` (kept for when they later opt into AI)

Rationale: a user linking an existing Gmail label is saying "these are already sorted, mirror it" — not "invent new rules to fill this folder". If they later want AI too, `EditFolderDialog` already exposes the toggles.

Folders created **without** a Gmail label (pure Zerrow folder they intend to define rules for) keep the current AI-on default.

Files:
- `src/lib/gmail/folder-mgmt.functions.ts` — set `skip_ai: true, min_ai_confidence: 0.75` in the insert when `gmail_label_id` is provided.
- No UI changes required; existing edit UI already lets them re-enable AI.

## 2. One-time cleanup for Jared

- Set his Kenect Reports folder to `skip_ai=true` so no more incidental AI matches file into it.
- Reclassify the 9 AI-routed rows: null out `folder_id`, requeue via `message_jobs`, so they route by the current (correct) label / rule state. Manual moves and Gmail-labeled rows are untouched.

## 3. Guardrails / verification

- Log in `gmail.create_folder` audit whether `skip_ai_default` was applied, so we can measure if new label-linked folders still collect AI-classified stragglers post-change.
- Add a test in `src/lib/gmail/folder-mgmt.test.ts` (new) covering: label-linked create → `skip_ai=true`; unlabeled create → `skip_ai=false`.

## Out of scope

- No changes to the classifier itself. The 9-row overfit here is a defaults problem, not a model problem.
- No sweep of other users' existing label-linked folders. If we later want that, it's a one-shot migration to set `skip_ai=true` for folders that have a `gmail_label_id`, an empty `filter_tree`, and no `ai_rule` — happy to do that as a follow-up once we've validated the new default in the wild.

## Technical details

The insert in `createFolder`:

```ts
.insert({
  user_id: context.userId,
  gmail_account_id: data.account_id,
  name: data.name,
  color: data.color ?? "#3b82f6",
  gmail_label_id: data.gmail_label_id ?? null,
  skip_ai: data.gmail_label_id ? true : false,
  min_ai_confidence: data.gmail_label_id ? 0.75 : 0,
})
```

Jared cleanup runs as one `supabase--insert` call (UPDATE folder + UPDATE emails + INSERT message_jobs).
