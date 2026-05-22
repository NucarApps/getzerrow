## Goal

When a contact is opened or enriched, generate an AI "Relationship summary" — who they are (role, company) and what your past correspondence with them has been about (topics, recurring threads, last interaction). Display it on the contact detail page.

## Changes

### 1. Database (migration)
Add to `contacts`:
- `relationship_summary text` — multi-sentence AI summary
- `summary_generated_at timestamptz`

### 2. `src/lib/contacts.functions.ts`
Extend `enrichContact` (and run as part of the same flow so the existing "Re-enrich" button regenerates the summary too):

- After the existing field extraction, pull a broader sample of past emails for this sender — **both directions** of the conversation, not just inbound. Query `emails` for rows where `from_addr = contact.email` OR `to_addrs ILIKE %contact.email%`, ordered by `received_at desc`, limit ~30.
- For each, keep subject, direction (they sent / you sent), date, and a trimmed body tail (reuse existing `cleanTail`, ~600 chars).
- Send to Gemini 2.5 Flash with a prompt like: "Write a 3–5 sentence briefing for the user about this contact. Cover: who they are (name, role, company if known), the nature of your relationship (client, vendor, colleague, recruiter, friend, etc.), and the main topics / projects you've discussed. Use 'you' for the account owner. Be specific — reference actual topics from the emails. If there's not enough signal, say so briefly."
- Save result to `relationship_summary` + `summary_generated_at` in the same UPDATE as the other enrichment fields.
- Skip regeneration on the 30-day cache path unless `force=true` (same rule as field extraction).

### 3. `src/routes/_authenticated/contacts.$id.tsx`
- Add a "Relationship summary" card directly under the header (above the action buttons), styled like an AI panel (subtle border, `Sparkles` icon, muted background).
- Show `c.relationship_summary` when present; show a skeleton/"Generating summary…" line while `enriching` is true and no summary exists yet; show "No summary yet — click Re-enrich" if enriched but empty.
- Update the auto-enrich effect (already runs on first visit for email-sourced contacts) — no change needed, the same call now also generates the summary.
- Re-enrich button label stays the same; tooltip/helper text updated to "Re-read past emails and refresh summary."

## Out of scope
- No separate "regenerate summary only" button — piggybacks on Re-enrich.
- No streaming UI.
- No changes to list view.
- No realtime updates.
