## Goal
Allow longer custom instructions for daily folder summaries so detailed prompts (like the dealership analyst prompt, ~4,500 chars) can be saved.

## Where the cap lives
The 2,000-char limit comes from server-side validators in `src/lib/gmail.functions.ts` (the DB column is plain `text`, no limit):
- Line 709 (create): `instructions: z.string().max(2000)`
- Line 748 (update): `instructions: z.string().max(2000).optional()`

The Textarea in `FolderEditor.tsx` has no client-side cap, so the error you saw came from the server rejecting the save.

## Change
Raise both validators from `max(2000)` to `max(10000)`. 10,000 chars comfortably fits your prompt with room to spare while still preventing abuse / runaway token costs in the summary call.

No DB migration needed. No UI changes needed.

## Optional polish (let me know if you want it)
- Show a live character counter under the Instructions textarea (e.g. `4,512 / 10,000`).
- Surface a friendlier toast if the limit is ever hit again.

Tell me if 10,000 is the right ceiling or if you'd prefer something different (e.g. 20,000), and whether you want the character counter.