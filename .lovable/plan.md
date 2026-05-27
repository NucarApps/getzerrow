## Problem

Even after relaxing `toolChoice` to `"auto"` and adding a text fallback, the preview sandbox log shows:

```
proposeAssistantChanges first attempt failed Model did not call propose_changes
proposeAssistantChanges retry failed Model did not call propose_changes
```

For your message:
> "Can you help me set up a filter inside of the signatures folder that if the subject starts with 'completed', I want it to go to notifications?"

That's a clean, unambiguous request. Gemini should easily produce `add_filter` on Notifications with `field: subject, op: starts_with, value: "completed"`. Instead it returns **nothing** — no tool call, no text — which means the AI SDK + OpenAI-compatible adapter + Gemini combination is choking on our tool schema.

The root cause is the schema shape: a Zod `discriminatedUnion` of 4 action types nested inside an array, inside an object, sent through the `openai-compatible` provider. Gemini's structured-output path through OpenAI-compatible JSON Schema is unreliable for discriminated unions. When it can't satisfy the schema cleanly, it bails with an empty response instead of best-effort.

## Fix

Stop going through the AI SDK's `generateText` + `tool()` abstraction for this call, and instead call the Lovable AI Gateway directly with hand-written OpenAI-style function-calling JSON Schema. This is the pattern the project's own AI Gateway knowledge file recommends for structured extraction, and it gives us full control over the schema shape Gemini sees.

Edit only `src/lib/ai-assistant.server.ts`.

### 1. Replace `callModel` with a direct `fetch` to the gateway

```ts
fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.LOVABLE_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "google/gemini-3-flash-preview",
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: "function", function: { name: "propose_changes", parameters: { ... } } }],
    tool_choice: { type: "function", function: { name: "propose_changes" } },
  }),
});
```

Then parse `choices[0].message.tool_calls[0].function.arguments` (JSON-parse the string) and validate it with the existing Zod schema. If `tool_calls` is missing, fall back to `choices[0].message.content` as the text-mode reply (already handled in the current code path).

### 2. Flatten the action schema

Gemini handles flat object schemas much better than discriminated unions. Replace the `discriminatedUnion` with a single `action` object that has all possible fields optional, plus a required `type` enum:

```json
{
  "type": "object",
  "properties": {
    "reply": { "type": "string" },
    "clarifying_question": { "type": "string" },
    "actions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": { "type": "string", "enum": ["move_email","add_filter","remove_filter","update_folder_rule"] },
          "email_id": { "type": "string" },
          "to_folder_id": { "type": "string" },
          "folder_id": { "type": "string" },
          "filter_id": { "type": "string" },
          "field": { "type": "string", "enum": ["from","domain","subject"] },
          "op": { "type": "string", "enum": ["contains","equals","starts_with"] },
          "value": { "type": "string" },
          "ai_rule": { "type": "string" },
          "why": { "type": "string" }
        },
        "required": ["type"]
      }
    }
  },
  "required": ["actions"]
}
```

Then, after parsing, run each action through the existing Zod `actionSchema` (the strict discriminated union) to drop invalid ones. The model gets a permissive schema; we still enforce strictness on our side before returning.

### 3. Keep the rest

- `proposalSchema` Zod still used for final validation of `reply`, `clarifying_question`, and per-action shapes.
- Prompt content stays as-is (already improved last turn).
- Retry-once and 402/429 error surfacing stay.
- Text fallback (when no tool call but text present) stays.

### 4. Drop the now-unused AI SDK imports

`generateText` and `tool` from `"ai"` and `createLovableAiGatewayProvider` from `./ai-gateway` are no longer needed by this file. Remove only from this file (other files still use them).

## Why this will work

- Direct fetch + OpenAI-style function calling is exactly the pattern in the project's `connecting-to-ai-models` knowledge file under "Extracting structured output". Gemini through the Lovable gateway is well-tested with this shape.
- Flat object schemas are reliably honored by Gemini; discriminated unions are not.
- We keep strict validation in Zod after parsing, so the apply step is still safe.

## Files touched

- `src/lib/ai-assistant.server.ts` — only file changed. No UI, no DB, no schema changes, no changes to `ai-assistant.functions.ts` or `AssistantPanel.tsx`. The `AssistantProposal` shape returned to callers is unchanged.

## Out of scope

- No model swap.
- No changes to apply path or action validation in `ai-assistant.functions.ts` (that file already validates with its own discriminated union — perfect second line of defense).
