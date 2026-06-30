## Goal

Make the **Inbox assistant** chat smarter so it can diagnose *why* mail is being misfiled instead of reacting to a single hand-picked email. It should look across recent/related mail, understand each folder's full instruction set, and propose durable fixes — better instructions, domain filters, removing conflicting filters, and bulk moves.

## Problems today

- The assistant only receives the emails you manually select (`selected_email_ids`). With nothing selected it's blind; with one selected it can't see a pattern.
- It never sees a folder's `learned_profile` — only the short `ai_rule` — so its rewrites ignore what the classifier actually learned.
- Per-email context is thin (`from_addr`, `subject`, `snippet`, `folder_id`). No sender domain, reply flag, calendar flag, or *why it landed where it did* — exactly the signals needed to explain a misfile.
- Actions are one-at-a-time on selected emails. "Move everything from @acme.com to Clients" isn't expressible.

## Changes

### 1. Richer context gathering — `src/lib/ai-assistant.functions.ts`
In `proposeAssistantChanges.handler`, in addition to selected emails:
- **Include `learned_profile`** in the folder query and in `AssistantContextFolder`.
- **Recent folder sample:** lightweight free-text parse of the user message to detect a referenced folder name (fuzzy match against the user's folders). When matched, load that folder's ~20 most recent emails (decrypted) as context so the model can see the misfiling pattern.
- **Domain clustering:** load a recent window (~150) of the account's emails, aggregate counts by sender domain + current folder, and pass the top ~15 domain clusters (domain, count, which folders they currently land in). This is what powers "add a domain filter" suggestions without the user selecting anything.
- **Richer per-email signals:** extend `AssistantContextEmail` with `domain`, `is_reply` (from `in_reply_to`), `has_calendar_invite`, `list_id`, and `classification_reason` so the model can explain and target fixes.
- Keep all reads `.eq("user_id", context.userId)` / account-scoped (no security change).

### 2. New + improved actions — `src/lib/ai-assistant.server.ts` and `.functions.ts`
- Add **`move_matching`** action: `{ field: from|domain|subject, op, value, to_folder_id }` — moves all of the user's emails matching the criteria into a folder (capped, e.g. 200 per apply) and is normally paired with an `add_filter` so future mail follows. Implemented in `applyAssistantChanges` by querying owned matching emails and calling `performMove` per row (reuse existing ownership checks).
- Add **`update_folder_profile`** action: rewrite the longer `learned_profile` (validated, ≤2000 chars) so the assistant can fix classifier drift, not just the short rule.
- Update the JSON tool schema (`TOOL_PARAMETERS_SCHEMA`), the Zod `actionSchema` (both files), and the apply handler's ownership pre-checks to cover the two new action types.

### 3. Stronger prompt/instructions — `buildPrompt` in `ai-assistant.server.ts`
- Surface the new context blocks: per-folder `learned_profile`, the recent-folder sample, and the domain clusters.
- Add guidance so the model:
  - **Diagnoses across multiple emails** — identify the shared signal (sender, domain, list-id, reply-vs-automated) causing the misfile before proposing a fix.
  - **Prefers durable fixes**: a `domain` filter over repeated single moves; `move_matching` + `add_filter` when many existing emails share a signal.
  - **Detects competing filters** in *other* folders that would re-catch the mail and proposes `remove_filter` for them.
  - **Refines instructions precisely**: tighten `ai_rule` / `learned_profile` to exclude the misfiled class (e.g. "human replies are NOT automated invites") rather than broadening.
  - Explains its reasoning in each action's `why`.

### 4. UI — `src/components/inbox/AssistantPanel.tsx`
- Add `Action` variants and `describeAction` cases for `move_matching` ("Move all <field> <op> "value" → Folder") and `update_folder_profile` ("Refine learned profile for …").
- Update the empty-state example prompts to showcase the new power (e.g. *"Replies from clients keep landing in Invitations — fix it"*, *"Move everything from @acme.com to Clients and keep it there"*).
- No change to the approve-before-apply flow; new actions render as normal reviewable checkboxes.

### 5. Tests
- Extend assistant-related unit coverage (or add a focused test) for: action schema parsing of the two new types, and the domain-cluster aggregation helper (pure function, extracted for testability).

## Technical notes

- Reuses `performMove` (`move-email.server.ts`), `getEmailsDecrypted` (`encrypted-reader`), and the existing per-action ownership verification — no new privileged paths.
- All AI calls stay server-side via the existing Lovable AI Gateway call in `ai-assistant.server.ts`; same model, same retry/credit-error handling.
- Bulk move is capped and applied row-by-row through the audited `performMove` so side-effects and Gmail label sync stay consistent.
- No schema/migration changes required — `folder_filters`, `learned_profile`, and `in_reply_to` already exist.

## Out of scope

- Changing the background classifier pipeline (`sync/*`) or the auto-relearn cron.
- Persisting assistant chat history (panel stays session-only).
