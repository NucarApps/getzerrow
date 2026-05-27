## Problem

Server logs show the assistant is failing with:

```
proposeAssistantChanges first attempt failed Model did not call propose_changes
proposeAssistantChanges retry failed Model did not call propose_changes
```

Your message ("Anything inside the signatures folder that starts with 'completed for signature' I want to go to notifications") is a valid request — it should become a `subject starts_with "completed for signature"` filter on the **Notifications** folder (and optionally remove any competing filter on **Signatures**).

But we force Gemini to call the `propose_changes` tool with `toolChoice: { type: "tool", toolName: "propose_changes" }`. When Gemini is uncertain (no emails are selected, it wants to ask a clarifying question, or the wording is ambiguous to it) it sometimes refuses the forced tool call entirely. Our code then throws, the retry does the same thing, and the user sees the generic "I had trouble understanding that" fallback — which hides whatever the model actually wanted to say.

## Fix

Edit only `src/lib/ai-assistant.server.ts`. Three changes:

### 1. Stop forcing the tool call

Change `toolChoice` from forced to `"auto"`. The model can still call `propose_changes`, but is also allowed to reply with plain text.

### 2. Capture text when the tool isn't called

In `callModel`, if the tool didn't fire, fall back to the model's `text` output and return it as a proposal with:
- `reply` = the model's text (if it looks like a confirmation/summary), OR
- `clarifying_question` = the model's text (if it ends with a question mark), and
- `actions: []`.

This means the user always sees what the model actually said, instead of our canned fallback.

### 3. Strengthen the prompt for filter-style requests

Update `buildPrompt` so the guidance explicitly covers this case:

- "If the user describes a routing rule by sender/domain/subject (with or without selected emails), propose `add_filter` on the target folder. You do NOT need a selected email to add a filter."
- "If a user says 'anything that starts with X goes to folder Y', use `add_filter` with `field: subject, op: starts_with, value: X` on folder Y. If a folder currently has a filter that would catch the same mail and route it elsewhere, also propose `remove_filter` for that filter."
- Reaffirm: "Prefer calling the `propose_changes` tool. Only reply in plain text if you genuinely need to ask a clarifying question and cannot express it via `clarifying_question`."

### 4. Keep the existing error surface

The 402 / 429 / generic catch block stays. The single retry stays too, but is now only meaningful for true gateway errors — not for "model declined to call tool", because we now handle that gracefully via the text fallback.

## Files touched

- `src/lib/ai-assistant.server.ts` — only file changed. No UI, no DB, no other server fns, no changes to the `AssistantProposal` shape the client consumes.

## Expected result for your example

For "Anything inside the signatures folder that starts with 'completed for signature' I want to go to notifications" the model should now propose:

- `add_filter` on **Notifications**: `subject starts_with "completed for signature"`
- optionally `remove_filter` on the Signatures filter that currently catches it

…with a short `reply` summarizing what it will do, and you approve in the panel as usual.

## Out of scope

- No model swap, no schema rework, no changes to `ai-assistant.functions.ts` or `AssistantPanel.tsx`.
- No changes to the apply path.
