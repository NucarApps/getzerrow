## Goal

In the folder editor, let the user describe a folder's purpose in plain language (e.g. "This is an invitation folder for Google Meet, Zoom, and similar invitations") and have AI generate a concise AI rule, which fills the existing **AI rule** textarea.

## UX

In `src/components/folders/FolderEditor.tsx`, just above the existing AI rule textarea (lines 315–318):

- Add a small "Generate from purpose" section: a one-line input/textarea where the user types the folder's purpose, plus a **Generate** button with a sparkle icon.
- On click, call a new server function with the purpose text (and the folder name for extra context). While running, show a spinner / "Generating…" state.
- On success, populate `local.ai_rule` with the returned rule (the user still reviews and saves via the existing Save flow). Show a success toast.
- Surface AI gateway errors as toasts, including the 429 (rate limit) and 402 (out of credits) cases.
- Keep the existing manual textarea fully editable — generation just pre-fills it.

## Server side

- Add `generateAiRuleFromPurpose` helper in `src/lib/ai.server.ts` (server-only), using the existing Lovable AI Gateway provider + `generateText` pattern already in that file (default model `google/gemini-2.5-flash`). Prompt: turn a short description of a folder's purpose into a concise, classifier-friendly AI rule (1–2 sentences describing the kind of email that belongs), returning plain text. Trim/cap output length.
- Add a `generateFolderAiRule` server function in `src/lib/gmail.functions.ts` (mirroring the existing `createServerFn` + `requireSupabaseAuth` pattern used by the other folder functions), validating input (`purpose`, optional `folder_name`) with zod, and calling the helper.

## Technical notes

```text
FolderEditor.tsx
  └─ new "Describe purpose" input + Generate button (above AI rule textarea)
        → useServerFn(generateFolderAiRule)({ data: { purpose, folder_name } })
              → ai.server.ts: generateAiRuleFromPurpose() via Lovable AI Gateway
        → setLocal({ ...local, ai_rule: result })
```

- No DB schema changes; the generated text only fills the existing `ai_rule` field and is persisted through the current Save button.
- Never call AI from the client — generation goes through the server function only.

## Verification

- Type a purpose, click Generate, confirm the AI rule textarea fills with a sensible rule.
- Confirm the textarea remains manually editable and Save persists it.
- Confirm rate-limit / no-credit errors show a toast instead of failing silently.
