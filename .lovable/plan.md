## Plan

Fix the inbox search so `Robb Moris` / `rob morris` can still find close name matches, but does not let broad Gmail/body hits like Donald Gaskins through.

### What I found

- The current local filter requires every search token to fuzzy-match visible metadata, but the fuzzy logic is too permissive:
  - `moris` is allowed edit distance 2, so it can match `gaskins`.
  - Gmail also returns broad full-text/body matches, then the UI fetches those rows by message ID.
- That combination explains why Donald Gaskins appears even though the visible result has nothing to do with Robb Morris.

### Changes

1. **Make fuzzy matching stricter for names**
   - Keep prefix/substring behavior so `rob` can match `robb`.
   - Only allow edit-distance fuzzy matches between similarly sized words.
   - Lower longer-token tolerance so `moris` can match `morris`, but not unrelated words like `gaskins`.

2. **Score whole-query relevance, not just per-token existence**
   - Prefer matches from sender name/email and subject over snippet-only matches.
   - Require multi-word people searches to match strongly in visible fields before showing the row.

3. **Prevent broad Gmail hit IDs from bypassing relevance**
   - Continue using Gmail to discover older/archived messages.
   - Keep the UI-side filter as the final gate so Gmail body-only noise is discarded.

4. **Add focused unit coverage for the fuzzy helper**
   - Cover `rob` → `robb`.
   - Cover `moris` → `morris`.
   - Cover `moris` not matching `gaskins`.
   - Cover `rob moris` not matching Donald Gaskins-style metadata.

### Verification

- Run the relevant tests for the new search utility.
- Verify the code path still keeps existing Gmail search behavior for older mail, while the visible inbox list only shows relevant results.