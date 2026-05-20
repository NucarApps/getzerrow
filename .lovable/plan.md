## What I found

The app only has the May 18 message stored locally for `braund_erik@officeonkatmai.help`. Gmail shows today's 9:28 email as `Re: Christopher - Office question`, which is likely a reply in the same Gmail thread. The current Gmail-backed search checks only `from:<email>` and only inserts brand-new message IDs. It does not handle the case where Gmail returns an existing thread/message record while a newer reply in that thread is missing locally.

## Plan

1. **Make Gmail fallback search thread-aware**
   - When Gmail search returns matches, fetch the full Gmail thread for each match.
   - Ingest every message in the matching thread that is not already in the local `emails` table.
   - This will catch today’s reply even when the search result points at the older May 18 thread message.

2. **Store enough data for searched messages to display correctly**
   - Use full Gmail message fetches for search ingestion, not metadata-only fetches.
   - Save sender, subject, snippet, body, labels, read/archive state, and received time.
   - Preserve the current folder mapping from Gmail labels where applicable.

3. **Improve resync safety net for recent mail**
   - On manual resync, include a recent Gmail search/backfill pass across the mailbox, not just history events.
   - Keep the existing history sync, but add this fallback so missed history/webhook events don’t leave recent replies invisible.

4. **Refresh the current search results after ingestion**
   - After Gmail fallback ingests any new thread messages, refetch the email list so the new 9:28 message appears immediately in the current view.

## Technical notes

- Add Gmail helper for `GET /users/me/threads/{threadId}?format=full`.
- Update `searchGmailAndIngest` to dedupe by `gmail_message_id` after expanding thread messages.
- Avoid changing the database schema.
- Keep existing folder-label behavior and RLS/auth patterns unchanged.