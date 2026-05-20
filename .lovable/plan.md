# Fix "No object generated: response did not match schema"

## Why

The Daily Digest run failed with `No object generated: response did not match schema`. That error comes from the AI SDK's structured-output validator in `summarizeFolderEmails` (`src/lib/ai.server.ts`). It fires when the model's reply either isn't valid JSON or doesn't fit the Zod schema we hand it.

With your ~5,000-char executive-briefing instructions covering many sections (OEM updates, recalls, financial alerts, action items, customer alerts, etc.), the model is almost certainly producing a long, well-formed digest that overruns the schema's hard caps — specifically:

- `body_text: z.string().min(1).max(20000)`
- `body_html: z.string().min(1).max(40000)`

A multi-section dealership digest can easily blow past 20 KB of plain text. When that happens the SDK throws the exact error you saw and we record it on the schedule row.

There are two contributing problems:

1. **Schema is too strict** for the kind of output your instructions request.
2. **No fallback** when structured output fails — one bad run sets `last_error` and you see the red banner with no way to recover except the next scheduled tick.

## What to change

### 1. Loosen the digest schema
In `src/lib/ai.server.ts` → `summarizeFolderEmails`:
- Drop the `.max()` caps on `body_text` and `body_html`. Keep `min(1)` and the subject cap.
- Keep the schema otherwise identical.

### 2. Add a graceful fallback when structured output fails
Wrap the `generateText({ output: Output.object… })` call in a try/catch.
- On failure, retry once with plain `generateText` (no structured output) asking the model to return a Markdown digest.
- Convert that Markdown to a minimal HTML body (simple heading/list rendering) and use the first non-empty line as the subject.
- Return the same `{ subject, body_text, body_html }` shape so the email still sends.
- Record the fallback path in the schedule's `last_error` as an informational note (e.g. "Used plain-text fallback — structured output failed once") rather than a hard error, so you know it happened but the row isn't marked broken.

### 3. Use a stronger model for the digest
The classifier reasonably uses `gemini-2.5-flash`, but a 200-email executive briefing benefits from more capacity. Switch the digest call to `google/gemini-2.5-pro` (still on Lovable AI, no API key needed). Classifier stays on flash.

### 4. Truncate input to stay safely under context
Before building the prompt, cap each email snippet at 240 chars (already done) and cap the total email count at 150 if the combined prompt would exceed a safe size. This protects against pathological inputs (e.g. a folder with 1,000 messages in 24h).

### 5. Surface a "Run now" retry from the schedule card
The Daily Digest card already shows the play (▶) button. Make sure clicking it after an error clears `last_error` on success so the red banner disappears immediately rather than only after the next cron tick. This is a one-line tweak in `runFolderSummary` — it already sets `last_error: null` on success, so verify the UI invalidates the schedules query after manual run.

## What this does NOT change
- No change to your saved instructions.
- No change to classification, folders, or Pub/Sub.
- No change to the schedule timing (8:00 AM America/New_York stays).
- No new tables or env vars.

## Technical notes
Files touched:
- `src/lib/ai.server.ts` — schema loosening, fallback path, model switch for the digest.
- `src/lib/summaries.server.ts` — tiny: pass through fallback marker to `last_error`.
- `src/components/folders/FolderEditor.tsx` (or wherever the ▶ handler lives) — confirm it invalidates the schedules query on success.

After this lands, your Daily Digest will either succeed with the full structured output or fall back to a plain-text digest that still gets delivered to your inbox, instead of producing the schema error.
