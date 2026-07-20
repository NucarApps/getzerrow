## Plan

1. **Fix Google label rename failures**
   - Update the Google contact-group API wrapper to send the saved group `etag` and `resourceName` when renaming labels.
   - This addresses the observed People API error: `Fingerprint is missing`, which is why labels such as `Factory - VW` are not appearing correctly.

2. **Fix Google membership reads for `myContacts` and labels**
   - Correct the contact-group member fetch so it does not request invalid `memberResourceNames` in `groupFields`.
   - This addresses the observed `Invalid groupFields mask path: "member_resource_names"` error that prevented promoting Zerrow contacts into Google’s main Contacts list.

3. **Make label reconciliation run before the contact backlog**
   - Keep label creation/renaming and `myContacts` promotion at the start of the push flow so they run even while hundreds of contacts remain dirty.
   - Ensure group membership reconciliation can run independently instead of waiting behind contact body/photo updates.

4. **Improve contact backlog draining**
   - Preserve the existing source-of-truth behavior, but make the sync tick process contacts in bounded batches with clear progress so repeated syncs keep reducing the dirty count.
   - Avoid letting photo retries or stale links block body/label sync.

5. **Add regression tests**
   - Add tests for the contact-group rename payload requiring `etag`.
   - Add tests for the corrected group member fetch mask and label formatting behavior.

6. **Verify with backend logs/status**
   - Re-run the Google contacts sync endpoint after changes.
   - Check that the previous `Fingerprint is missing` and `Invalid groupFields mask path` errors disappear, and that dirty contact/link counts decrease.