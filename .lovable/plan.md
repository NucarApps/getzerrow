## Goal

Make the per-folder chat maintain durable memory. Today it already sees the folder's current rules, AI instructions, filters, and a live sample of emails on every turn — but the conversation itself lives only in React state (`FolderChatPanel.tsx`) and is wiped when you close the folder editor or refresh. There is no chat table. We'll persist chat history + a log of applied changes per folder, and keep long conversations useful with a "replay recent + summarize older" strategy.

## What we'll build

### 1. Database (one migration)

**`folder_chat_messages`** — one row per turn, scoped to user + folder:
- `folder_id`, `user_id`, `role` (`user` | `assistant`)
- `content` (text)
- `actions` (jsonb, null for user turns) — the assistant's proposed changes
- `applied_action_indexes` (jsonb array) — which of those actions the user actually approved (the applied-changes log)
- `created_at`
- RLS scoped to `auth.uid() = user_id`, plus `GRANT`s for `authenticated` and `service_role`.

**`folder_chat_state`** — per-folder rolling memory:
- `folder_id` (PK), `user_id`, `summary` (text) — condensed memory of older turns and what was done, `summarized_through` (timestamp/marker), `updated_at`
- Same RLS + GRANT pattern.

### 2. Server (`folder-chat.functions.ts` + `folder-chat.server.ts`)

- **New `getFolderChatHistory`** server fn: verifies folder ownership, returns the persisted recent messages (with their actions + applied flags) and the current memory summary, so the panel can rehydrate on open.
- **`proposeFolderChanges`** (existing) now:
  1. Persists the incoming user message.
  2. Loads the memory summary + recent persisted turns from the DB (instead of trusting client-sent history), keeping the current live folder settings/rules/profile/filters/email sample it already gathers.
  3. Feeds the model: memory summary block + applied-changes context + recent verbatim turns + live folder context.
  4. Persists the assistant reply (with its proposed actions).
- **`applyFolderChanges`** (existing) now also records which actions were approved on the matching assistant message (`applied_action_indexes`) — the applied-changes log the model will read next time.
- **Summarization step** in `folder-chat.server.ts`: when a folder's stored turns exceed a threshold (e.g. ~24), fold the oldest turns + prior summary into an updated `folder_chat_state.summary` via a Lovable AI call, then mark those turns as summarized so only recent turns are replayed verbatim. This keeps "forever" memory without unbounded token cost.
- `buildPrompt` gets a new memory/summary + applied-changes section so the model always knows what happened before and what was already changed.

### 3. Client (`FolderChatPanel.tsx`)

- On mount, call `getFolderChatHistory` and rehydrate `turns` (rendering prior user/assistant messages, past proposed changes, and their applied/dismissed state) instead of starting empty.
- Keep the existing send/apply/discard UX; persistence is handled server-side, so after apply we refresh state from the server.
- Show a subtle "Loading conversation…" state while history loads, and keep the empty-state hint only when there's genuinely no history.

## Technical notes

- Scope: per-folder (matches today's chat scoping). Memory is keyed by `folder_id` + `user_id`.
- The live folder rules, AI instructions, and current email sample stay computed fresh each turn (unchanged) — only chat history and the applied-changes log become persisted, plus the rolling summary for older turns.
- All reads/writes go through `createServerFn` with `requireSupabaseAuth` (ownership verified via `supabaseAdmin` as today); no client-side DB writes.
- Summarization uses the existing Lovable AI Gateway path already used in `folder-chat.server.ts`; failures degrade gracefully (fall back to replaying whatever recent turns exist).
- Files touched: new migration; `src/lib/folder-chat.functions.ts`; `src/lib/folder-chat.server.ts`; `src/components/folders/FolderChatPanel.tsx`.

## Verify

- Chat in a folder, close and reopen the editor / refresh — prior messages and proposed-change cards reappear.
- Apply a change, start a new turn, and confirm the assistant references what was already done.
- Have a long conversation and confirm older turns get folded into the summary while recent turns stay verbatim, with the assistant still recalling earlier decisions.
