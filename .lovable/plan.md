## Goal

Reduce full iOS Contacts resyncs by (a) letting iOS ask "what changed since last time?" via RFC 6578 `sync-collection` and (b) keeping our ETag/CTag/If-None-Match semantics strict enough that iOS trusts its cache between polls.

## Current state (verified)

- `computeBookCTag` moves on any contact/group `updated_at` bump and on row-count changes — good CTag.
- ETag per contact/group is stable and used by PUT/DELETE via `If-Match` / `If-None-Match: *`.
- PROPFIND on the addressbook returns one `<response>` per contact + per group with ETag → iOS still has to `addressbook-multiget` everything on any CTag change.
- No RFC 6578 support: neither `<D:sync-token>` nor `sync-collection` in `supported-report-set` is advertised, so iOS never issues an incremental REPORT.
- Hard deletes: `handleDelete` removes contacts/groups outright, so a sync-token approach has nowhere to learn what disappeared.
- GET/HEAD does not honor `If-None-Match`, so a device that already has the current ETag still gets the full vCard body.

## Changes

### 1. Tombstone table for deletions

New table `carddav_tombstones` so incremental sync can report removed resources:

```text
carddav_tombstones
  user_id uuid
  resource_type text  -- 'contact' | 'group'
  resource_id  uuid
  deleted_at   timestamptz default now()
  sync_seq     bigserial   -- monotonic ordering for sync tokens
  PRIMARY KEY (user_id, resource_type, resource_id)
```

RLS: `auth.uid() = user_id`. GRANTs to `authenticated` + `service_role`. No `anon`.

Insert a tombstone whenever `handleDelete` removes a contact or a group (both paths already exist in `handlers.server.ts`). Old rows are pruned by a small cron (keep 90 days); a client that hasn't synced in longer gets a `valid-sync-token` failure and falls back to full sync — the RFC-defined behavior.

### 2. sync-token model

A sync-token encodes "server state at time T for user U". We use:

```text
sync-token = "urn:zerrow:carddav:<user_id>:<max_seq>"
```

`<max_seq>` = greatest of the newest `contacts.updated_at` epoch-ms, `contact_groups.updated_at` epoch-ms, and `carddav_tombstones.sync_seq` for the user. Encoding as a single opaque string is what RFC 6578 requires; iOS treats it as opaque.

### 3. Advertise sync support

In `propfindAddressbook` add to the addressbook props:

- `<D:sync-token>...current token...</D:sync-token>`
- `<D:supported-report-set><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report>...(existing addressbook-multiget + addressbook-query)</D:supported-report-set>`

In `handleOptions` extend DAV header: `DAV: 1, 3, addressbook, extended-mkcol` and keep `Allow` as-is.

### 4. sync-collection REPORT

In `handleReport`, before the existing multiget branch, detect `<D:sync-collection>` and handle it:

- Parse `<D:sync-token>` (empty string / missing → treat as "initial sync": return every current resource).
- Parse `<D:sync-level>` (`1` supported; anything else → 403 `<D:number-of-matches-within-limits/>` per RFC — we'll respond `400` with the standard precondition XML).
- Parse optional `<D:limit><D:nresults>N</D:nresults></D:limit>`.
- Query:
  - `contacts` where `updated_at > since` for user
  - `contact_groups` where `updated_at > since` for user
  - `carddav_tombstones` where `sync_seq > since_seq` for user
- Return one `<D:response>` per changed contact/group with ETag (+ address-data if requested) and one `<D:response>` per tombstone with `<D:status>HTTP/1.1 404 Not Found</D:status>`.
- Trailer: `<D:sync-token>NEW_TOKEN</D:sync-token>` reflecting the max seq covered by the response (respect `limit` by clamping and setting the token to the last emitted row — subsequent syncs will pick up the rest).
- If the incoming token references a `since_seq` older than the oldest surviving tombstone (pruned), respond `403` with `<D:error><D:valid-sync-token/></D:error>` so iOS gracefully falls back to a full sync.

### 5. If-None-Match → 304 on GET/HEAD

`handleGet` (both group and contact branches) reads `If-None-Match`, computes the current ETag first, and if they match responds `304 Not Modified` with just the `ETag` header (no body). This saves the vCard payload on every reconciliation poll where nothing changed for that item.

### 6. Keep CTag consistent with deletions

Extend `computeBookCTag` to include `max(sync_seq)` from `carddav_tombstones` so a delete moves the CTag even when no other row changed. Format stays the same opaque quoted string.

### 7. Tests

Add `src/lib/carddav/sync.test.ts`:

- Initial `sync-collection` with empty token returns all rows + a fresh token.
- After creating/updating a contact, second `sync-collection` with the previous token returns only that contact and a new token.
- After deleting a contact, second `sync-collection` returns a `404` tombstone entry.
- `If-None-Match` on GET with the current ETag returns 304 and no body.
- Stale token (older than pruned tombstone horizon) returns 403 `valid-sync-token`.

## Non-goals

- No addressbook-query filter grammar changes — iOS uses sync-collection once advertised.
- No CalDAV, no schedule-tag, no calendar collections.
- Group-membership–only edits already move `contact_groups.updated_at` via existing triggers, so no extra plumbing there.

## Files touched

- New: `supabase` migration for `carddav_tombstones` + prune function.
- Edit: `src/lib/carddav/handlers.server.ts` (PROPFIND advertisement, sync-collection branch in `handleReport`, tombstone inserts in `handleDelete`, 304 in `handleGet`, CTag update).
- Edit: `src/lib/carddav/xml.ts` (small helper to parse `<D:sync-token>` / `<D:sync-level>` / `<D:limit>`).
- Edit: `src/routes/api/public/carddav/$.ts` — no route changes, `REPORT` already dispatches.
- New: `src/lib/carddav/sync.test.ts`.
- Edit: `src/routes/_authenticated/settings.carddav.tsx` — one-line note that iOS now uses incremental sync.
