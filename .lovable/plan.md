# Folder settings chat with AI-proposed changes

Add a **Chat** tab inside the folder editor where you can describe what you want, and the AI proposes concrete changes to *that folder's* settings, rules, and filters. Nothing is written until you review each proposed change and approve it — matching the existing inbox assistant's approve-then-apply flow.

## What the chat can change

Scoped to the folder you're editing:
- **AI rule** (short natural-language rule) and **learned profile** (longer classifier description)
- **Filters** — add or remove field/op/value rules
- **Behavior toggles** — auto-archive, auto mark-read, auto-star, hide from inbox, rules-only (skip AI), beat "always send to inbox", cold-email folder
- **Delivery settings** — auto-forward address, snooze-on-arrival hours, min AI confidence, filter match logic (any/all)
- **Basics** — name, color, priority

## User experience

```text
Folder editor
 ├─ Settings tab
 ├─ History tab
 └─ Chat tab  ← new
      • Message thread (you ↔ assistant)
      • Assistant replies + a "Proposed changes" card
        each change has a checkbox + plain-language description + reason
      • [Discard]   [Apply selected]
      • Composer textarea + send
```

Examples the user can type:
- "Also auto-archive everything here and hide it from my inbox."
- "Rename this to Receipts and make the color green."
- "Stop letting human replies land here — tighten the rule."
- "Forward everything in this folder to billing@acme.com and snooze for 24 hours."

On **Apply selected**, approved changes save, the folder editor's Settings tab reflects the new values immediately, and folder lists refresh.

## Technical plan

### New server functions — `src/lib/folder-chat.functions.ts`
Dedicated, single-folder scoped (kept separate from the inbox assistant which is account-wide).

- `proposeFolderChanges({ folder_id, user_message, history })`
  1. Verify the folder belongs to `context.userId` (via `supabaseAdmin`), load all its columns + its `folder_filters` + a small sample of recent emails currently in it (decrypted through `getEmailsDecrypted`, same pattern as the inbox assistant).
  2. Build a prompt describing the folder's current settings, filters, and definitions of each setting, then call the Lovable AI Gateway with an OpenAI-style `propose_changes` tool (flat JSON-schema object, like `ai-assistant.server.ts`).
  3. Return `{ reply, clarifying_question, actions }`.
- `applyFolderChanges({ folder_id, actions })`
  - Verify folder ownership once, then apply each approved action; return per-action `{ ok, error }` results.

### Action types (single folder)
- `add_filter` / `remove_filter` — reuse existing folder-filter logic (dedupe + ownership checks).
- `update_folder_rule` — set `ai_rule`.
- `update_folder_profile` — set `learned_profile`.
- `update_folder_settings` — a patch of optional fields: `name`, `color`, `priority`, `auto_archive`, `auto_mark_read`, `auto_star`, `hide_from_inbox`, `skip_ai`, `overrides_inbox_override`, `is_cold_email`, `forward_to`, `snooze_hours`, `min_ai_confidence`, `filter_logic`. Values are clamped/validated server-side (confidence 0–1, snooze 0–720, forward_to trimmed/nullable, color hex, etc.). The tool schema exposes each as an optional property so the model only sets what it wants to change.

### Server prompt/model
- New `src/lib/folder-chat.server.ts` modeled on `ai-assistant.server.ts`: builds the prompt, defines the flat tool schema, calls the gateway (`google/gemini-3-flash-preview`), validates with Zod (loose parse → drop invalid actions), one retry on schema failure, and graceful 402/429 messages. Read-only — never writes.

### UI — `src/components/folders/FolderChatPanel.tsx`
- Chat thread + proposed-changes cards with checkboxes, reusing the interaction pattern from `AssistantPanel.tsx` (turns state, select/apply/discard, "Thinking…" indicator, Enter-to-send).
- `describeAction` renders each change in plain language, including a per-field summary for `update_folder_settings` (e.g. "Turn on auto-archive · Set color to green · Rename to Receipts").
- After apply: invalidate `["folders"]` / `["folders-full"]` / `["folder-filters", folderId]`, and lift the applied settings back into the editor via an `onApplied(patch)` callback so the Settings tab updates without a remount.

### Wire into `FolderEditor.tsx`
- Add a third `TabsTrigger`/`TabsContent` ("Chat") and render `<FolderChatPanel folder={local} onApplied={(patch) => setLocal((p) => ({ ...p, ...patch }))} />`.

### Notes
- No new DB tables or migrations — all fields already exist on `folders` / `folder_filters`.
- Follows project rules: AI only via the gateway server-side, ownership verified with `supabaseAdmin`, no client AI calls.
