## Root cause

The reply email is in the DB with `classified_by: "none"`, `folder_id: null`. That's what gets written when the AI classifier throws inside `classifyParsedEmail` → `catch (e) { console.error("AI classify failed", e) }`.

Server logs confirm it: every reanalyze attempt today is failing with

```
AI_NoObjectGeneratedError: No object generated: response did not match schema.
```

So the AI gateway call to `google/gemini-3-flash-preview` (in `src/lib/ai.server.ts → classifyEmail`) returns text the `ai` SDK's structured-output adapter can't parse against the Zod schema. The folder isn't actually being chosen — the classifier crashes silently, folder stays `null`, and the UI dutifully reports "no change" because `email.folder_id (null) === result.folder_id (null)`.

Reanalyze itself is fine; the AI step is the bug.

## Plan

1. **Switch the classifier model to a stable, structured-output-friendly model.**  
   `google/gemini-3-flash-preview` is a preview model and is the one throwing `AI_NoObjectGeneratedError`. Change `getModel()` in `src/lib/ai.server.ts` so `classifyEmail` uses `google/gemini-2.5-flash` (reliable JSON-mode support). Keep the other helpers on whatever model they were on, or move all of them — simplest is to switch the single shared `getModel()`.

2. **Make `classifyEmail` resilient to schema-parse failures.**  
   Wrap the `generateText` call in a one-shot retry: if the first call throws `AI_NoObjectGeneratedError`, retry once with a tighter prompt that explicitly demands JSON only. If both attempts fail, fall back to a plain-text `generateText` call and `JSON.parse` the response (best-effort), and only then give up. This keeps reanalyze working even if a future model regresses on structured output.

3. **Surface real classifier errors to the user instead of "no change".**  
   In `classifyParsedEmail` (`src/lib/sync.server.ts`), when the AI step throws, return a `classified_by: "ai_error"` (or similar) with the error message in `classification_reason`, instead of silently leaving `classified_by: "none"`. Then in `reanalyzeEmail`'s response (`src/lib/gmail.functions.ts`) and in the inbox UI toast (`src/routes/_authenticated/index.tsx`), show that reason — so when AI can't classify, the user sees "AI couldn't classify: …" instead of a misleading "no change".

4. **Re-run reanalysis on the Eric Braund reply once the fix is shipped.**  
   No data migration needed — clicking "Reprocess" on that email will now succeed and route it to **Cold Email** based on the folder's `ai_rule` text already configured.

### Files to edit
- `src/lib/ai.server.ts` — swap model in `getModel()`; add retry + JSON-parse fallback in `classifyEmail`.
- `src/lib/sync.server.ts` — return `classified_by: "ai_error"` with the error message when the AI step throws.
- `src/lib/gmail.functions.ts` — propagate the error reason in the `reanalyzeEmail` return shape.
- `src/routes/_authenticated/index.tsx` — show that reason in the reprocess toast.

No DB / schema changes. No new dependencies.
