## Problem

When you sent an assistant message, the server log shows:

```
proposeAssistantChanges failed No object generated: response did not match schema.
```

The AI gateway did reply — but the model's JSON didn't match our strict schema (discriminated union of 4 action types, each with required fields like `why`, `field`, `op`, etc.), so the AI SDK threw. Our catch block then showed the generic "Sorry, I couldn't reach the AI right now" message, which made it look like an outage.

## Fix

Make the assistant resilient to model output quirks and surface real errors instead of pretending it's offline.

### 1. Switch to tool-calling for structured output

`src/lib/ai-assistant.server.ts` — replace `generateText` + `Output.object(...)` with `generateText` + `tools` and `toolChoice`. Tool-calling is the pattern the project's own knowledge file recommends for structured output and is much more reliable on Gemini than JSON-schema response mode for discriminated unions.

### 2. Loosen the schema so the model can't fail validation on trivia

- Make `why` optional with a default of `""` (was required, max 200).
- Make `reply` and `clarifying_question` optional with `""` defaults.
- Keep the discriminated union of action types, but allow `actions: []` (already allowed).

### 3. Use the project's default chat model

Switch from `google/gemini-2.5-flash` to `google/gemini-3-flash-preview` (the project-wide default per the AI Gateway knowledge), which handles tool-calling more cleanly.

### 4. Better error surface

In the catch block in `proposeAssistantChanges`:
- Still log the full error server-side.
- Return a `clarifying_question` that distinguishes the real failure modes the user might hit:
  - 402 → "AI credits are exhausted for this workspace."
  - 429 → "Too many requests right now, try again in a moment."
  - schema/parse error → "I had trouble understanding that — could you rephrase what you'd like me to do?"
  - other → current generic message.

### 5. (Optional) One automatic retry

If the first call throws a schema/no-object error, retry once with a slightly stronger system reminder ("Respond ONLY by calling the propose_changes tool."). Single retry, no loop.

## Files touched

- `src/lib/ai-assistant.server.ts` — only file changed. No DB, no UI, no other server fns.

## Out of scope

- No changes to the AssistantPanel UI, the apply path, or the proposal data shape that the client consumes (`reply`, `clarifying_question`, `actions[]` stay identical).
- No changes to `ai-assistant.functions.ts`.
