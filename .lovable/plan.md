I checked the database: only one `braund_erik@officeonkatmai.help` message exists locally, from May 18. There is no locally stored message from today around 9:28, so the current search can only show yesterday’s copy.

Plan:

1. Add a Gmail-backed search fallback
- Keep the existing fast local search first.
- If the search text looks like an email address or sender/domain and local results are incomplete, call Gmail directly for matching messages.
- Insert any Gmail matches into the local `emails` table so they become searchable and visible afterward.

2. Make search results show newly pulled Gmail matches immediately
- Add a server function like `searchGmailAndIngest` using the connected Gmail account.
- Search Gmail with a query such as `from:braund_erik@officeonkatmai.help newer_than:30d`.
- Fetch up to 50 matching Gmail messages, parse metadata/content, and upsert them locally.
- Re-run/refetch the search after ingestion so today’s email appears without a manual sync.

3. Preserve folder behavior
- If the Gmail message has a label linked to one of the app folders, assign that local `folder_id`.
- If it has no linked folder label, store it as unfiled/inbox depending on Gmail labels.
- Do not re-apply labels that the user manually stripped.

4. Improve the UI feedback
- While searching, show a small “checking Gmail…” state after local results load.
- If Gmail returns nothing, show that no matching Gmail messages were found locally or in Gmail.

Technical notes:
- This will use the existing Gmail connector helpers and TanStack server functions.
- No new database tables are needed.
- This directly addresses the reason you only see yesterday’s email: today’s message is not currently ingested into the app database.