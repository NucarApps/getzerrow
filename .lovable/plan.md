I’ll fix the search to behave like a person/name search instead of trusting every broad Gmail full-text hit.

Plan:
1. Tighten local filtering for multi-word searches like `rob morris`
   - Split free-text terms into tokens.
   - Require all tokens to match visible email metadata (`from_name`, `from_addr`, `to_addrs`, `subject`, or `snippet`) unless Gmail returns a high-confidence exact phrase match.
   - Stop showing rows solely because Gmail returned the message ID when the visible row has no relationship to the query.

2. Make Gmail search more precise for names
   - For multi-word free-text queries, send Gmail an exact phrase query (`"rob morris"`) instead of a broad raw query.
   - Keep current email/domain behavior (`from:email`, `from:domain`) unchanged.
   - Keep operator searches like `from:` / `to:` working as explicit filters.

3. Preserve older-message ingestion without polluting results
   - Continue ingesting Gmail hits so older relevant emails can appear.
   - Only merge Gmail-hit rows into the visible result list if they also pass the stricter local/person search filter.
   - Keep the rate-limit handling already added.

4. Validate with the Rob Morris case
   - Confirm the result list no longer includes Donald Gaskins / Andy Loconto style unrelated rows for `rob morris`.
   - Check server logs for Gmail search errors and verify the UI still shows the rate-limit/reconnect states when needed.