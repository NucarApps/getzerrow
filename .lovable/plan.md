## Plan: stop “Unknown / (no subject)” rows from returning after page changes

1. **Fix the shared email cache collision**
   - The sidebar and the inbox both use the same React Query key: `["emails"]`.
   - The sidebar query only loads count fields, so after navigating pages it can overwrite the inbox’s full email data with partial rows.
   - Give the inbox list and sidebar counts separate query keys, then invalidate both when email data changes.

2. **Make the inbox resilient to partial rows**
   - Keep the inbox query selecting full email details only.
   - Add a lightweight guard so rows missing both sender and subject are not rendered as fake “Unknown / (no subject)” emails while a refetch is happening.

3. **Keep refresh and realtime updates consistent**
   - Update refresh, mark-read, archive, trash, folder learning, and folder reassignment invalidations to target the new query keys.
   - This keeps counts and message details in sync without one query overwriting the other.

4. **Verify the data path**
   - Confirm the database has real sender/subject values and the issue is UI cache pollution, not Gmail parsing.
   - Check the relevant files after edits so the query keys and invalidations are consistent.