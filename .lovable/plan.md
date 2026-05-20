## Goal

In the email reader, add three connected capabilities:
1. **Move to folder** — pick any folder from the reader header.
2. **Why this folder?** — expandable panel explaining how the classification happened.
3. **Move similar too** — after a manual move, offer to move other matching emails (preview list with per-row checkboxes + select-all).

## 1. Capture & show classification reason

### Schema
Add `classification_reason text` to `emails` (nullable). Populated alongside `classified_by`:

| `classified_by` | `classification_reason` example |
|---|---|
| `gmail_label` | `Matched Gmail label "Factory"` |
| `filter` | `Filter: from contains "@acme.com"` (the specific rule that hit) |
| `domain_rule` | `Domain rule: acme.com → Factory` |
| `ai` | AI's one-line rationale (extend `classifyEmail` output with a `reason` field, separate from `summary`) |
| `manual_move` | `Moved manually on <date>` (set in move handler) |
| `none` | null |

Update:
- `src/lib/sync.server.ts` — set `classification_reason` at insert + in `recordManualMove` + label-import paths.
- `src/lib/ai.server.ts` — extend Zod output schema with `reason: z.string().max(200)` and return it; pass through to the insert.
- `src/lib/gmail.functions.ts` — set reason in `reassignDomainToFolder`, `suggestRecategorization` apply, and the new move fn.
- No backfill needed; older rows just show "—" in the panel.

### UI — Reader
Below the AI summary box, add a collapsible **"Why this folder?"** section (shadcn `Collapsible` with chevron). When expanded shows:
- Trigger type chip (AI / Filter / Gmail label / Domain rule / Manual)
- `classification_reason` text
- Confidence bar when AI
- Link "Edit folder rules →" jumping to that folder's edit sheet

## 2. Move to a different folder from the reader

Header gets a **"Move to…"** dropdown next to the existing folder badge. Lists all folders (excluding current) with their color dot. Selecting one:
- Calls new server fn `moveEmailToFolder({ email_id, to_folder_id })` in `src/lib/gmail.functions.ts`:
  - Updates `emails.folder_id`, `classified_by="manual_move"`, `ai_confidence=1`, `classification_reason="Moved manually on …"`.
  - Best-effort Gmail label sync (add target label, remove source label) using existing `modifyMessage`.
  - Adds a `folder_examples` row for the target (source `"correction"`), removes any in the source — same pattern already used by `applyRecategorization`.
  - Returns `{ from_folder_id, from_addr, domain }` so the UI can immediately open the "Move similar?" dialog.

## 3. "Move similar" dialog

After a successful move, open a sheet/dialog:

### Server fn `findSimilarEmails`
Input: `{ email_id, from_folder_id, mode: "sender" | "domain" }` (default `sender`).
Returns the other emails currently in `from_folder_id` where:
- `sender` mode → `from_addr = <original from_addr>`
- `domain` mode → `from_addr` ends with the original domain

Selects `id, subject, from_addr, from_name, received_at, snippet` ordered by `received_at desc`, limit 50.

### Server fn `bulkMoveEmails`
Input: `{ email_ids: string[] (max 100), to_folder_id }`.
Loops through and applies the same move logic as `moveEmailToFolder` (extract to a shared internal helper). Returns `{ moved, failed }`.

### Dialog UI (new `MoveSimilarDialog.tsx`)
- Toggle pill: **Same sender** / **Same domain** (re-runs `findSimilarEmails`).
- List of matching emails, each row: checkbox + sender + subject + relative time. Select-all in the header.
- Footer: count selected + "Move N to {target folder}" button.
- Empty state: "No other matching emails in {source folder}".

## Files

- **Migration**: add `classification_reason text` to `emails`.
- `src/lib/ai.server.ts` — extend classifier output with `reason`.
- `src/lib/sync.server.ts` — write `classification_reason` everywhere `classified_by` is set.
- `src/lib/gmail.functions.ts` — `moveEmailToFolder`, `findSimilarEmails`, `bulkMoveEmails` (+ internal shared move helper).
- `src/routes/_authenticated/index.tsx` — Reader: "Move to" dropdown, "Why this folder?" collapsible, wire dialog.
- `src/components/emails/MoveSimilarDialog.tsx` (new) — the preview + bulk-confirm dialog.

## Notes / non-goals

- The "Move to" picker reuses the same folder list already fetched in the inbox; no extra round-trip.
- Bulk move stays capped at 100 to keep one click bounded and avoid Gmail rate limits; if the user has more than 100 matches we show the cap with a hint.
- We do **not** auto-create a domain filter on bulk move — the "create a routing rule" flow already lives in the Folder editor's domain suggestions. We can add a "Also auto-route this sender/domain in the future" checkbox in a follow-up.
