# Fix "Couldn't read the card: No object generated"

## What's happening

`scanCard` in `src/lib/contacts.functions.ts` calls the Lovable AI Gateway with `Output.object({ schema })` on `google/gemini-2.5-flash`. When the model returns text that the AI SDK can't validate against the Zod schema, the SDK throws `No object generated` and we re-throw it as `Couldn't read the card: No object generated`.

The same pattern was already solved in `classifyEmail` (`src/lib/ai.server.ts:84-131`), which tries structured mode, then falls back to plain text + manual JSON parse, then to other models. `scanCard` has none of that — one shot, one model, no recovery.

## Fix

Rewrite the body of `scanCard.handler` to use the same multi-tier fallback chain, scoped to vision-capable models.

### Steps

1. **Extract a vision-prompt builder** inside the handler that returns the same instruction text used today, plus an explicit JSON-shape instruction for the text-JSON path:
   ```
   Respond with ONLY a JSON object (no markdown, no prose, no code fences) of this exact shape:
   {"name":<string|null>,"title":<string|null>,"company":<string|null>,"email":<string|null>,"phone":<string|null>,"website":<string|null>,"linkedin":<string|null>,"twitter":<string|null>}
   ```

2. **Add two helpers inside the handler** (mirroring `ai.server.ts`):
   - `tryStructured(modelId)` — current call, uses `Output.object({ schema: SCAN_SCHEMA })`, returns `null` on throw and stores `lastError`.
   - `tryTextJson(modelId)` — calls `generateText` without `Output.object`, strips ```json fences, slices from first `{` to last `}`, `JSON.parse`, then `SCAN_SCHEMA.parse`. Returns `null` on any throw and stores `lastError`.

3. **Chain the attempts** (all vision-capable models on the gateway):
   ```
   tryStructured("google/gemini-2.5-flash")
     || tryTextJson("google/gemini-2.5-flash")
     || tryStructured("google/gemini-2.5-flash-lite")
     || tryTextJson("google/gemini-2.5-flash-lite")
     || tryTextJson("google/gemini-2.5-pro")
   ```
   First non-null wins.

4. **Error message** — if all attempts return null, throw:
   `Couldn't read the card: AI vision returned no parseable response (last error: <lastError>)`. This gives us a useful clue in the toast next time instead of a bare "No object generated".

5. **Server logs** — `console.error` each failed attempt with model id + last error (same shape as `classifyEmail`) so we can see in `stack_modern--server-function-logs` which model/path is misbehaving on real cards.

## Out of scope

- UI (`contacts.scan.tsx`) — no change. Same `scan({ data: { imageDataUrl } })` call, same toast pipeline.
- `createContactFromScan`, `sendMyCard`, `Output.object` usage elsewhere — unchanged.
- No new dependencies, no schema changes, no new env vars.

## Files touched

- `src/lib/contacts.functions.ts` — only the `scanCard` `.handler(...)` body (~30 lines).

## Verification

1. After the edit, retry the scan with the same card → expect either a populated draft, or a more specific error message identifying which model/path failed.
2. If it still fails, the error text + server logs will tell us whether the gateway is rejecting vision input on these models (different remediation: open a Lovable AI Gateway issue) vs. the model genuinely can't read the card.
