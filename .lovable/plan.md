## Problem

The "Run AI scan" button toasts "AI suggestions ready" but the drawer stays empty. Investigation:

- AI Gateway logs show the model call succeeds (200, thousands of output tokens).
- The `contact_group_suggestions` table has zero rows — nothing was ever persisted.
- Root cause: the prompt asks Gemini to echo back full contact UUIDs, and the server filters out any suggestion whose returned `contact_ids` aren't in `validContactIds`. Every suggestion is dropped because the model paraphrases/hallucinates UUIDs (or returns fewer than 3 that match), so 0 rows insert and the drawer shows "No suggestions yet".

Two secondary issues make it hard to notice:
- The `onSuccess` toast unconditionally says "AI suggestions ready" — it never reflects that 0 were produced.
- No server-side logging tells us how many were parsed vs kept, so this failure is silent.

## Fix

Edit only `src/lib/contacts/suggest-groups.functions.ts` and the drawer's success toast.

1. **Reference contacts by short numeric handle instead of UUID.**
   - Build a compact list `[{ i: 1, n, co, t, d, city, g }, ...]` and pass a `contact_ids` array of small integer `i` values in the schema (`z.array(z.number().int().positive())`).
   - After parsing, map each `i` back to the real UUID via an index → id lookup, then apply the existing dedupe/validation. This eliminates UUID hallucination.
   - Update the prompt to say "use the `i` field" and never echo the UUIDs.

2. **Return counts from the server function** so the client can show a truthful toast:
   - `{ suggestions, stats: { parsed, kept, inserted } }`.
   - Drawer toast becomes: `Found N suggestions` when > 0, or `AI didn't find anything new to suggest` when 0.

3. **Add structured server logs** (`logInfo` from `@/lib/log.server`) at parse time and insert time with `parsed_count`, `kept_count`, `dropped_missing_ids`, so any future regressions are visible in server-function logs.

4. **Slightly relax the 3-contact minimum for `merge_into_existing`** to 2 — merging into an existing group with 2 new members is still useful, and stricter filtering was contributing to empty results.

No schema changes. No UI changes beyond the toast wording. Rate limit and cooldown stay as-is.

## Files touched

- `src/lib/contacts/suggest-groups.functions.ts` — swap UUID handle for integer index, add stats + logs, adjust min-contacts rule for `merge_into_existing`.
- `src/components/contacts/GroupSuggestionsDrawer.tsx` — use returned `stats` for the toast copy.

## Verification

- Click "Run AI scan" in the drawer. Server logs should show `parsed_count` and `kept_count > 0`. `contact_group_suggestions` should have rows for the latest `run_id`. Drawer lists them; toast reflects the count. When the model genuinely returns nothing useful, the drawer says so instead of "ready".
