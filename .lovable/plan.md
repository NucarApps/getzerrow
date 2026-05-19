## Link folders to existing Gmail labels + continuous learning

Today every Zerrow folder creates a new `Zerrow/<name>` Gmail label. Instead let a folder bind to any existing Gmail label, seed the AI from what's already in it, and keep learning whenever you move an email into that label by hand in Gmail.

### 1. Schema changes (migration)

Add to `folders`:
- `learned_profile` (text, nullable) — AI-generated description of the folder's pattern, used as few-shot context for classification.
- `last_learned_at` (timestamptz, nullable).

New table `folder_examples`:
- `id`, `folder_id` (fk), `user_id`, `gmail_message_id`, `from_addr`, `subject`, `snippet`, `source` (`seed` | `manual_move`), `created_at`.
- RLS: authenticated users only. Unique (`folder_id`, `gmail_message_id`).

### 2. Link existing Gmail label when creating/editing a folder

In `folders.tsx`:
- Add a "Gmail label" Select (powered by a new `listGmailLabels` server fn) shown both in the create card and in `FolderEditor`. Options: "Create new Zerrow/<name>" + every existing user label.
- When linking, save the chosen `gmail_label_id` on the folder without creating a new label.
- Show the linked label name as a chip on each folder card.

### 3. "Learn from this folder" action

New `learnFromFolder` server fn:
1. Resolve folder + `gmail_label_id`.
2. List up to 50 most recent Gmail messages with that label, parse them.
3. Upsert each into `folder_examples` with `source: 'seed'`.
4. Send the example signals (from, subject, snippet — no full bodies) to Lovable AI and ask for a 1–3 sentence profile describing what belongs in this folder. Store on `folders.learned_profile` and stamp `last_learned_at`.
5. Surface a "Learn from existing emails" button per folder + a status line showing example count and last learned time.

### 4. Use learned context in classification

In `sync.server.ts` + `ai.server.ts`:
- Pass `learned_profile` (and a handful of recent example subjects) alongside `ai_rule` into `classifyEmail`. AI prompt becomes: rule + profile + few-shot examples per folder.
- Filters still run first; AI is the fallback.

### 5. Continuous learning from manual moves

`syncSinceHistory` already walks Gmail history. Extend it to also process `labelsAdded` events:
- If a user-added label matches any folder's `gmail_label_id`, and we haven't already recorded that message as an example for that folder, insert into `folder_examples` with `source: 'manual_move'` and update the local email's `folder_id`.
- If `>= N` (e.g. 5) new manual-move examples accumulated since `last_learned_at`, re-run the profile-generation step in the background so the AI stays current. Otherwise just append the example.
- The polling cron (already firing) keeps this loop running without extra setup.

### 6. UI polish

- Folder card: show "Linked to: <Gmail label>", "Learned from N emails", "Last learned <time>", and a "Re-learn" button.
- Toast on successful learn with count.

### Out of scope
- No retroactive reclassification of already-imported emails (can add later behind a button if you want).
- No negative examples — only positive (emails the user placed in the folder).
