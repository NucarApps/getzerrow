# Smarter Re-enrich: scan more emails, prefer ones with signatures

## Problem
Today `enrichContact` only looks at the **5 most recent** emails from the person and feeds them all to the model. If those happen to be phone replies ("Sent from my iPhone", no signature), we get nothing useful — even when older desktop emails from the same person have a full signature block.

## Change (single file: `src/lib/contacts.functions.ts`, `enrichContact` handler)

1. **Pull a larger candidate pool** — fetch up to **40** most recent emails from `from_addr = contact.email` (still `body_text`, `snippet`, `subject`), instead of 5.

2. **Score & pick the best ~8 for the prompt**, favoring emails that are likely to contain a real signature:
   - Strong negative signal: body contains "Sent from my iPhone / iPad / Android / mobile device / BlackBerry / Samsung" → deprioritize.
   - Positive signals: longer `body_text` (>400 chars), presence of typical signature tokens (a phone-number regex, `linkedin.com/in/`, `http(s)://`, "—", "--", "Best,", "Regards,", "Thanks,", "Cheers,", a line that looks like a job title with a company).
   - Sort candidates by score desc, take top 8. Always include at least 1–2 of the longest emails even if scoring is tied.

3. **Per-email signature trimming** — instead of sending 2,500 chars of each body, take the **tail** of each email (last ~1,500 chars) where the signature lives, and strip obvious quoted-reply blocks (`^>` lines, `On <date> ... wrote:` and everything after). This lets us fit more distinct emails into the prompt without blowing context.

4. **Prompt tweak** — tell the model it's looking across multiple emails from the same sender and should merge fields, preferring values that appear in more than one email; still return `null` when not clearly present. Sender email stays pinned so it never invents an address.

5. **Merge behavior unchanged** — same `patch` logic: fill empty fields, or overwrite all fields when `force = true` (the "Re-enrich" button already passes `force: true`).

No DB schema changes. No UI changes. No new dependencies.

## Out of scope
- Scanning emails **to** this person (only `from_addr` is used, same as today).
- Parsing HTML signatures from `body_html` — keeping `body_text`/`snippet` only to match current behavior. Can add later if results are still thin.
