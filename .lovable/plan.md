Add fuzzy matching so "rob" finds "Robb", "Robert", etc.

1. Local fuzzy token matching (inbox.tsx)
   - For each free-text token, match against any word in `from_name`/`from_addr`/`to_addrs`/`subject`/`snippet` if:
     - the word contains the token as a substring (current behavior), OR
     - the word starts with the token (prefix match — "rob" → "robb", "robert"), OR
     - Levenshtein distance ≤ 1 for tokens 3–4 chars, ≤ 2 for tokens 5+ chars (handles "rob"↔"robb", "morris"↔"moris").
   - Tokens shorter than 3 chars stay as exact substring to avoid noise.
   - Keep the "all tokens must match" rule so unrelated rows still get filtered out.

2. Broaden Gmail query for short name searches (gmail.functions.ts)
   - For multi-word free text, instead of an exact `"rob morris"` phrase (which Gmail won't match against "Robb Morris"), send each token as a separate required term: `rob morris` (default AND), letting Gmail's own tokenizer/stemming widen the net.
   - Drop the forced quote-wrapping added in the last change; rely on the stricter local fuzzy filter to discard true noise.
   - Keep `from:email` and `from:domain` shortcuts unchanged.

3. Verify
   - Search "rob morris" and confirm Robb Morris results appear and unrelated rows stay out.
   - Confirm single-token searches still work and rate-limit/reconnect UI is intact.

Technical notes
- Levenshtein implemented inline (small DP, ~15 lines) — no new dependency.
- Tokenization splits metadata on `[^a-z0-9]+` for word-level fuzzy compare.