## Problem

Google People API `contactGroups.list` rejected our request:

```
400 INVALID_ARGUMENT — Unknown name "requestSyncToken":
Cannot bind query parameter. Field 'requestSyncToken' could not be found in request message.
```

Unlike `people.connections.list` (which requires `requestSyncToken=true` to receive a `nextSyncToken`), `contactGroups.list` does **not** accept that parameter — it returns `nextSyncToken` automatically whenever pagination completes. We are sending it in `src/lib/google-contacts/people-client.server.ts:159` and `pull.server.ts` passes `requestSyncToken: true`, which breaks every groups pull and blocks the whole contacts sync.

## Fix

1. **`src/lib/google-contacts/people-client.server.ts`** — in `listContactGroupsPage`, drop the `requestSyncToken` query param entirely (keep it in the `opts` type as a no-op for call-site compatibility, or remove it from the signature — I'll remove it to keep the surface honest). `syncToken` and `pageToken` stay.

2. **`src/lib/google-contacts/pull.server.ts`** — remove `requestSyncToken: true` from the `listContactGroupsPage` call in `paginateGroups`. Leave the `people.connections.list` call untouched — that one legitimately needs `requestSyncToken: true`.

No schema, UI, or auth changes. Behavior after fix: groups still paginate and still return `nextSyncToken` on the final page, so incremental group sync keeps working.

## Verification

- Typecheck.
- User clicks "Sync now" on `chris@nucar.com`; the groups pull no longer 400s and `google_sync_state.last_error` clears.
