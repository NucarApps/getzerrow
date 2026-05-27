## Plan

Add an AI assistant chat panel inside the inbox that can reason about the currently selected email (or multi-selection) and propose folder / filter changes for the user to approve before anything is written.

### What the user sees

- A new **Ask AI** button in the inbox toolbar opens a side panel (sheet) on the right.
- The panel header shows what the AI can see right now: the selected email's sender, subject, current folder. If multiple rows are selected, it says "12 emails selected".
- A chat thread with a text input at the bottom. The user types things like:
  - "These should go to Marketing instead of Sales."
  - "Stop routing anything from this sender to Receipts."
  - "Create a rule so emails from @acme.com always land in Clients."
- The assistant replies with a short summary plus a **proposed change card** listing each change:
  - Move this email (and/or matching past emails) from Folder A to Folder B.
  - Add filter rule on Folder B: `from contains rob@acme.com`.
  - Remove filter rule on Folder A: `domain contains acme.com`.
  - Optional: tighten Folder A's AI rule / broaden Folder B's AI rule.
- Each change has a checkbox so the user can toggle individual edits.
- Two buttons: **Apply selected** and **Discard**. Nothing changes until Apply is clicked.
- After Apply, the assistant confirms what was actually changed and stays open for follow-ups.

### How it works under the hood

1. **Context gathering** — when the user sends a message, the client passes the chat history plus the current selection (email IDs + selected folder). The server fn loads the email's metadata, its current folder, and the user's other folders + their existing filter rules.
2. **AI planning** — call Lovable AI Gateway with tool-calling. The model returns a structured proposal: list of `move_email`, `add_filter`, `remove_filter`, `update_folder_rule` actions plus a one-paragraph summary and a per-change rationale. No DB writes yet.
3. **Preview** — the proposal is rendered as the change card. The user toggles + approves.
4. **Apply** — a second server fn validates the user owns every referenced folder/email/filter, then executes the approved subset using the existing helpers (`moveEmailToFolder`, `bulkMoveEmails`, insert/delete on `folder_filters`, update on `folders.ai_rule`).
5. **Audit trail** — store each chat thread + applied changes so the user can review or undo later from the panel.

### Guardrails

- Read-only by default. The AI cannot mutate anything; only the Apply action does.
- Server-side ownership checks on every folder/email/filter ID before applying.
- Hard cap on bulk-move size per proposal (e.g. 200 emails) — anything larger asks the user to confirm a follow-up.
- Filter `value` length and field/op enums validated with zod.
- The AI is told it can only use the listed tools and may only reference folders that exist for this user.

### Files / surfaces

- New: `src/lib/ai-assistant.functions.ts` — `proposeFolderChanges`, `applyFolderChanges`.
- New: `src/lib/ai-assistant.server.ts` — Lovable AI Gateway call with tool definitions + ownership-safe applier.
- New table: `ai_assistant_threads` + `ai_assistant_messages` (RLS scoped to `auth.uid()`, grants for `authenticated` + `service_role`).
- New: `src/components/inbox/AssistantPanel.tsx` — sheet, chat thread, proposal card.
- Hook into `src/routes/_authenticated/inbox.tsx` toolbar with the new "Ask AI" button.

### Out of scope for v1

- Editing the visual filter tree builder from chat (only flat `folder_filters` rows + `ai_rule` text in v1).
- Cross-account moves.
- Undo of an already-applied proposal (just leaves an audit row for now).