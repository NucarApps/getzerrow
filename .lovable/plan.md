## What happened

You hit Reanalyze and saw:
> AI classifier failed: AI classifier returned no parseable response

In `src/lib/ai.server.ts`, `classifyEmail` tries 4 attempts in order (gemini‑2.5‑flash structured → text‑json → gemini‑2.5‑flash‑lite structured → text‑json). If all 4 return nothing parseable, it throws that generic message. `sync.server.ts` catches it and stores it as `classification_reason`, which the inbox toast surfaces verbatim.

The most likely causes for all 4 attempts coming back empty on this specific email (long VC pitch with financials):
1. Gemini safety/finish-reason cutoff returning empty text — common on long fundraising / financial bodies.
2. Transient 429/5xx from the gateway where all 4 retries hit the same upstream.
3. Body too large after concatenating folder profiles + examples + 4000 chars of body.

The current code logs only `e.message` and offers no escape hatch outside the Gemini family.

## Plan

### 1. Add a non‑Gemini fallback tier (`src/lib/ai.server.ts`)
Extend the fallback chain with `openai/gpt-5-mini` (text‑json) and then `openai/gpt-5-nano` (text‑json) after the existing 4 Gemini attempts. Different provider sidesteps Gemini-specific safety cutoffs and gateway hiccups.

### 2. Improve diagnostics
- On each failed attempt, log `e.name`, `e.message`, and (if present) `e.responseBody` / `e.status` so server logs show *why* (safety block vs 429 vs parse error). Today we lose all of that.
- When all attempts fail, throw an error that includes the last attempt's underlying message, e.g. `AI classifier returned no parseable response (last error: 429 rate limited)`. That message flows straight to the toast.

### 3. Trim the prompt on retry
For the final 2 fallback attempts, truncate `body_text` to 2000 chars (down from 4000) and drop the per-folder `Recent examples` block. This shrinks the request and removes the most common safety-trigger surface (quoted email bodies inside examples).

### 4. No behavior change on success
- Successful classification path is unchanged.
- `reanalyzeEmail` in `gmail.functions.ts` already keeps the current folder when the classifier abstains — that stays as-is. The fix only makes the abstain‑because‑error case much rarer and its message more actionable.

### Files touched
- `src/lib/ai.server.ts` — only file modified.

### Out of scope
- No DB changes.
- No UI changes (the toast just gets a better message via the existing path).
- Email body / classification logic itself unchanged.