## Diagnosis

The Relearn button calls `learnFromLinkedLabel(folder_id, user_id)` in `src/lib/sync.server.ts`. That function asks **Gmail** for messages with the folder's linked label (`labelIds: [folder.gmail_label_id]`) and seeds `folder_examples` from those.

For Tony's Factory-Nissan folder:
- It's linked to Gmail label `Label_24`.
- The 84 nissan-usa.com emails sit in the folder *inside Zerrow* (`emails.folder_id = ...`), but they were never tagged with `Label_24` in Gmail because:
  - The previous fix's data migration could only touch Postgres, not Gmail.
  - The new `bulkMoveEmails(create_rule)` path moves the local rows but only `modifyMessage`'s individual rows one at a time through `performMove`, not on the rule-driven path.

So Gmail's label has ~0 messages, Relearn fetches nothing, and the UI reports "no emails" — even though Zerrow clearly shows 84.

## Fix

### 1. Relearn should use local folder emails as the source of truth

Modify `learnFromLinkedLabel` so the example seed comes from the **union** of:

- The current Gmail-label query (unchanged behavior — catches mail labeled directly in Gmail but not yet synced locally).
- The folder's local `emails` rows (`SELECT id, gmail_message_id, from_addr, subject, snippet FROM emails WHERE folder_id = X LIMIT 200 ORDER BY received_at DESC`).

For local rows we already have `from_addr`, `subject`, `snippet` in the DB — no Gmail round-trip needed, so this also makes Relearn *faster*. Upsert into `folder_examples` with `source = "seed"` (or `"correction"` for rows already labeled `manual_move` / `domain_rule`).

This means: any email the user has put into a folder via any path (manual move, domain rule, Gmail label) is included in the learned profile.

### 2. Make rule-driven moves also push the Gmail label (best-effort)

In the new `bulkMoveEmails` create_rule branch, also call `modifyMessage` for each moved email to add the destination folder's `gmail_label_id` and remove `INBOX` — same as `performMove` already does for single moves. (Currently `performMove` does the per-email label sync, so this is actually already handled inside the loop. Verify by reading `performMove` — if so, no change here.)

Result of (1) alone is sufficient to fix the immediate complaint; (2) is just defensive verification — no plan to change behavior unless we find a gap.

### 3. One-off Gmail label backfill for Tony's 84 emails (optional)

Add a small server action `applyFolderLabelToLocal({ folder_id })` that iterates `emails WHERE folder_id = X AND <label not in raw_labels>` and calls `modifyMessage` to push `gmail_label_id` + remove `INBOX` for each. Surface it in `FolderEditor` as a button "Sync folder labels to Gmail" so Tony (and any future user in this situation) can align Gmail state on demand. This is the same logic that runs inline during `performMove`, just batched.

Recommend including this since Tony explicitly clicked Relearn expecting Gmail to know about these emails. Without it, his Gmail Inbox keeps showing the 84 as un-labeled even though Zerrow has sorted them.

## Files to change

- `src/lib/sync.server.ts` — extend `learnFromLinkedLabel` to seed from local `emails` rows in addition to Gmail label results.
- `src/lib/gmail.functions.ts` — add `applyFolderLabelToLocal` server fn.
- `src/components/folders/FolderEditor.tsx` — add "Sync folder labels to Gmail" button next to Relearn; surface count synced in a toast.

## Verification

- Tony clicks Relearn on Factory-Nissan → toast says "learned from N emails" (N ≥ 84) and `folders.learned_profile` becomes populated.
- Tony clicks "Sync folder labels to Gmail" → 84 messages get `Label_24` applied in Gmail and INBOX removed; next Relearn returns from both sources without duplication.
- A fresh future "Move similar by domain" still creates the rule, moves the matched local emails, and the per-email label sync inside `performMove` keeps Gmail in sync — so this never regresses for new users.

## Out of scope

- Reworking the learned-profile prompt itself (`regenerateFolderProfile`).
- Renaming or reorganizing the Relearn UI beyond adding the sync button.
