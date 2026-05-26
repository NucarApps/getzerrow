## Fix: "Always send to inbox" should mean allowlist, not blocklist

Today the classifier treats any hit on `inbox_overrides` as a global *exclude* — the message is auto-archived and AI is skipped. That contradicts the UI ("Always send to inbox") and the project's stated intent, and it's why Jim B's emails (and 8 others since 5/20) disappeared from the Zerrow inbox even though they're in Gmail.

You picked option 1: **inbox overrides are an allowlist**. A hit forces the email into the inbox and bypasses folder rules / AI. Exceptions let specific messages (e.g. `subject starts_with "RE: Daily Reports"`) fall back to normal sorting.

### Changes

**1. `src/lib/sync/classify.ts` — flip the override branch**
- When `overrideWins` is true, do NOT set `aiSkipped` and do NOT route to `global_exclude`.
- Instead: set `folder_id = null`, `classified_by = "inbox_override"`, `classification_reason = 'Always-inbox: ${match_type} "${value}"'`, and skip folder/AI evaluation entirely. Null folder + not archived = lands in inbox.
- Keep the existing `overrides_inbox_override` folder escape hatch (a folder flagged that way still beats the override — that flag becomes "this folder is important enough to pull mail out of the always-inbox list", which still makes sense).
- Keep the exception logic: an exception causes the override to be ignored and classification continues normally (filters → AI).

**2. `src/lib/sync/process-message.ts` — make sure side-effects respect override**
- Verify (and adjust if needed) that when `classified_by === "inbox_override"` we do NOT auto-archive, do NOT auto-mark-read, do NOT hide-from-inbox, do NOT forward, do NOT snooze. Folder side-effects only fire when a folder matched.

**3. Data cleanup migration**
- Un-archive existing emails that were wrongly archived by the old logic:
  ```sql
  UPDATE public.emails
     SET is_archived = false,
         classified_by = 'inbox_override',
         classification_reason = 'Restored: always-inbox rule (was incorrectly archived)'
   WHERE classified_by = 'global_exclude'
     AND is_archived = true;
  ```
- This brings Jim B's 9 messages and the Raymond Karen messages back into the inbox without a re-sync.

**4. `src/components/settings/InboxOverrides.tsx` — copy tweak**
- The label is already "Always send to inbox" so it's fine. Update the helper sentence about exceptions to match the new (correct) behavior — it already reads correctly, just verify wording matches "skip folder rules and AI sorting".

**5. Tests**
- Update `src/lib/sync-classify.test.ts`: the existing test that asserts `classified_by === "global_exclude"` on override hit should now assert `classified_by === "inbox_override"`, `folder_id === null`, and side-effects-not-applied.

### Out of scope
- No schema changes to `inbox_overrides` / `inbox_override_exceptions` — the tables and UI stay as-is.
- No blocklist feature. If you ever want "never put this in my inbox", that's a separate folder with a filter + `auto_archive` + `hide_from_inbox` — which is what folders already do.

### Files touched
- `src/lib/sync/classify.ts` (logic flip)
- `src/lib/sync/process-message.ts` (verify side-effect gating)
- `src/lib/sync-classify.test.ts` (update assertions)
- `src/components/settings/InboxOverrides.tsx` (minor copy check)
- New migration: un-archive the wrongly-archived rows
