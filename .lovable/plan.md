# Clean up folder setup: rules first, AI second, better AI helpers

Reorganize the folder Settings tab into two clear sections, make the existing AI chat easy to reach from the instructions field, and add a one-click way for AI to draft the folder instructions from the emails already under the linked Gmail label.

## 1. Reorder Settings into two sections

In `src/components/folders/FolderEditor.tsx` (Settings tab), regroup the existing controls under two labeled sections — no behavior changes, just order and headings:

- **Rules** (top): the deterministic **Filters** block (field/op/value list, allowlist/exclude rows, Match any/all, "Use rule groups…", and the add-filter row). This is the block currently near the bottom of the tab.
- **AI** (below): everything else, kept in its current internal order — Gmail label link, AI rule field, learned profile / learn-from-label, summaries, surface-to-inbox, the behavior toggles grid (auto-archive, mark-read, star, hide, rules only, beat inbox, cold email), and forward / snooze / min-confidence.

Each section gets a small heading (e.g. an uppercase label with a Filter icon for Rules and a Sparkles icon for AI) so the split reads clearly. The Save/Cancel bar, History tab, Chat tab, and Scan section stay as they are.

## 2. Make the AI chat discoverable from the instructions field

The full **Chat** tab (`FolderChatPanel`) already drafts and applies rule/setting changes, so we reuse it rather than adding a second chat.

- Convert the `Tabs` to a controlled component (add a `tab` state, pass `value`/`onValueChange`).
- Next to the "AI rule (natural language)" field, add a small **"Write with AI chat"** button that switches to the Chat tab. A one-line hint tells the user the chat can draft and refine these instructions.

## 3. Let AI draft instructions from the linked label's emails

Add a new **"Draft from label"** action beside the AI rule field. It samples the emails under this folder's linked Gmail label and asks AI to write the instructions, then drops the draft into the AI rule field for review (nothing saves until the user hits Save — same pattern as the existing "Generate rule").

- **Server helper** (`src/lib/ai.server.ts`): new `generateAiRuleFromLabelSamples({ folderName, samples })` that takes sender/subject/snippet samples and returns a concise 1–2 sentence rule (mirrors the existing `generateAiRuleFromPurpose` prompt/cleanup).
- **Server function** (`src/lib/gmail.functions.ts`): new `generateFolderAiRuleFromLabel` (auth middleware, `{ folder_id }` input). It verifies folder ownership, requires a linked `gmail_label_id`, samples up to ~40 messages from that label via the existing `listMessages` + `getMessageMetadata` + `parseMessage` helpers, and calls the new AI helper. Returns `{ rule }`.
- **UI** (`FolderEditor.tsx`): wire a `useServerFn` call; the button is disabled without a linked label and shows a loading state; on success it sets `local.ai_rule` and toasts "Draft ready — review, then save." Reuse the existing 429/402 error handling from `generateRule`.

## Technical notes

- No schema or migration changes. `ai_rule` already exists on `folders`.
- The label-sampling function follows project rules: it runs server-side through `requireSupabaseAuth`, verifies ownership, and reuses existing Gmail helpers (no new token handling).
- The filter engine and side-effect logic are untouched — this is purely a Settings-tab reorganization plus two additive AI entry points.

## Verification

- Typecheck/build.
- In the live app: open a folder's Settings tab, confirm Rules (filters) render first and all AI controls below; confirm "Write with AI chat" switches to the Chat tab; on a folder with a linked Gmail label, confirm "Draft from label" fills the AI rule field and Save persists it.
