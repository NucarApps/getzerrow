# Refocus relationship summary on "who is this person"

Right now the AI briefing in `src/lib/contacts/enrich.functions.ts` (lines ~290–376) reads the last ~30 emails with the contact and writes a 3–5 sentence recap that includes *the nature of your relationship* and *the main topics/projects you've discussed*. You want to drop the "past conversations" angle and have the AI infer identity only: who they are, who they work for, and what they do.

## Change

Rewrite the summary prompt (and its inputs) so it produces an identity briefing, not a relationship recap.

- Keep the email sampling as the source material (signatures, domains, and body context are still the best signal), but bias what we send to the model toward identity-bearing content:
  - Prefer inbound emails (`THEY SENT`) so we lean on their own signatures/self-descriptions.
  - Extract the signature block / tail of each inbound email (already partially done via `cleanTail`) and pass those, plus `from_addr` domain, rather than back-and-forth threads.
- Replace the prompt with an identity-only instruction:
  1. Who they are (name + likely role/title).
  2. Who they work for (company, inferred from signature, email domain, or explicit mentions — ignore generic domains like gmail.com).
  3. What they do (their function/industry, in one line).
  - 2–4 sentences, plain prose, no relationship framing, no "we discussed…", no project recaps. If signal is thin, say so briefly. Do not invent facts.
- Keep the persisted field name (`relationship_summary` / `summary_generated_at`) and the encrypted-write path unchanged so existing storage, CardDAV NOTE sync, and the "Rerun for everyone" driver keep working — only the content of the string changes.
- Leave name/title/company extraction logic above this block alone; it already sets those structured fields and the new prompt still benefits from them as `Known details`.

## Out of scope

- No schema changes, no new columns, no UI changes.
- No changes to the enrichment scheduler, batch runner, or CardDAV sync.
- Signature/relationship extraction into structured fields (title/company) already happens earlier in `enrichContact` and stays as-is.

## Technical notes

- File: `src/lib/contacts/enrich.functions.ts`, the block starting at `// === Relationship summary` (~line 290) through the `generateText` call (~line 370).
- Model stays `google/gemini-2.5-flash`.
- After shipping, a one-time "Rerun for everyone" from Settings → iPhone contacts will regenerate summaries in the new style; no migration needed.
