I found two likely causes behind the All inbox behavior:

1. The inbox page fetches email rows directly from the browser and only refetches after the sync button finishes. If realtime/query timing is slightly off, the list can temporarily show stale or incomplete cached rows until a full refresh.
2. The sync path skips existing email rows entirely, so if a row was created earlier with missing sender/subject/body metadata, later Sync Now will not repair it.

Plan:

- **Repair incomplete email rows during sync**
  - Update `processGmailMessage` so when a Gmail message already exists, it fetches the full Gmail message, parses sender/subject/snippet/body/received date/labels, and updates the local row instead of just returning `skipped`.
  - This fixes rows that currently show `Unknown` / `(no subject)`.

- **Make inbox refresh more reliable**
  - After the inbox refresh button finishes, invalidate/refetch the email list and account data consistently, matching the settings sync behavior.
  - Keep the current button and UI unchanged.

- **Prevent blank sender display from parsing edge cases**
  - Improve Gmail `From:` parsing so addresses without a display name don’t accidentally become blank sender values.

- **Validate**
  - Check recent email rows after the sync logic change to confirm sender and subject are populated.
  - Verify no route/UI behavior changes beyond the refresh correctness fix.