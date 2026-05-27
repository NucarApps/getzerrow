## Plan

The issue is not the empty-state UI — the Gmail search is finding candidate messages, then failing while expanding/ingesting them because the Gmail API is returning `rateLimitExceeded` quota errors. The current search path makes too many Gmail calls at once by deep-searching up to 500 hits, expanding full threads, then fetching many full messages concurrently.

## Changes to make

1. **Throttle Gmail search ingestion**
   - Reduce the number of Gmail hits processed per search so a normal search like “rob morris” does not blow through per-user Gmail quota.
   - Lower message/thread fetch concurrency and add small backoff handling for `rateLimitExceeded` responses.
   - Stop expanding every matching thread during interactive search; only pull direct Gmail search hits first, which is enough to display Rob Morris matches.

2. **Return clearer search status to the inbox UI**
   - Update `searchGmailAndIngest` to return a `rate_limited` reason when Gmail quota blocks ingestion.
   - Include `found` counts and already-known Gmail IDs even if some ingestion fails.

3. **Improve the empty-state messaging**
   - If Gmail found matches but ingestion was rate-limited, show a retry/wait message instead of “No matches”.
   - If Gmail found matches but no local rows are available yet, show that Gmail found results and the app is still pulling them in.

4. **Verify the behavior**
   - Use server logs to confirm quota errors stop or are handled gracefully.
   - Confirm the inbox no longer incorrectly says there are no Gmail matches when Gmail returned hits or rate-limited the pull.