## Goal

Contact groups become first-class in three places:
1. Two-way sync with iOS via CardDAV (vCard CATEGORIES + Apple group vCards).
2. Optional 1:1 link from a group to a folder, plus a reusable `sender_in_group` filter you can drop into any folder's rule tree.
3. Filter chips on the Contacts page to slice the list by one or more groups.

## Data model

Single migration:

- `contact_groups`: add `folder_id uuid null references folders(id) on delete set null`, `carddav_uid text` (stable UID exposed to iOS), `etag text`, `updated_at timestamptz`. Backfill `carddav_uid = 'group-' || id` and set `updated_at = now()`.
- Unique partial index `(user_id, folder_id) where folder_id is not null` so a folder is linked by at most one group.
- Add op `sender_in_group` to the allowed values in `folder_chat.functions.ts` / `folder_chat.server.ts` / filter engine. `value` stores the group id (uuid). No schema change to `folder_filters` — reuse existing `field`/`op`/`value` columns; `field` is set to `from` for consistency but ignored by the engine for this op.

## CardDAV two-way group sync

Extend `src/lib/carddav/vcard.ts`:
- `buildContactVCard` writes `CATEGORIES:` line joining the contact's group names (RFC-escaped, comma-separated).
- `buildGroupVCard(group, memberUids)` emits an Apple-style group card: `KIND:group`, `X-ADDRESSBOOKSERVER-KIND:group`, `FN:<name>`, one `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:<contact-uid>` per member.
- `parseVCard` picks up `CATEGORIES` (array) and, when `KIND:group` / `X-ADDRESSBOOKSERVER-KIND:group` is present, returns `{ kind: 'group', name, memberUids }`.

Extend `src/lib/carddav/handlers.server.ts`:
- Group resources live at `/carddav/<email>/contacts/group-<groupId>.vcf`. `PROPFIND` on the collection lists both contact and group hrefs with their ETags (contact etag already exists; group etag = md5 of name + sorted member ids + updated_at).
- `handleGet` returns the group vCard when the href points to a `group-*.vcf`.
- `handleReport` (multiget / query / sync-collection) includes group resources.
- `handlePut`:
  - Contact PUT: parse CATEGORIES, diff against current memberships for that contact, upsert missing `contact_groups` rows by case-insensitive name, insert/delete `contact_group_members` rows accordingly. Skip name diffing on the contact itself (unchanged path).
  - Group PUT: upsert `contact_groups` by `carddav_uid`, update name, then reconcile `contact_group_members` to exactly the parsed member UIDs. Honour `If-Match` / `If-None-Match` against the group etag.
- `handleDelete` on a `group-*.vcf`: hard-delete the group row (members cascade). Contacts remain.
- Bump `DAV`/`Allow` headers only if needed (already advertise write).

Concurrency: whenever `contact_group_members` or `contact_groups.name` changes (from either side), bump `contact_groups.updated_at` via trigger so the etag flips and iOS re-syncs.

## Folder link + `sender_in_group` filter

Server:
- `src/lib/contact-groups.functions.ts`: add `linkContactGroupToFolder({ groupId, folderId | null })`. When linking, also insert a `folder_filters` row `{ folder_id, field: 'from', op: 'sender_in_group', value: groupId }` if none exists for that (folder, group). When unlinking, delete that specific filter row. Extend `listContactGroups` to return `folder_id` and (optionally) the linked folder's `name`/`color`.
- `src/lib/sync/filter-engine.ts`:
  - Extend `EmailForFilter` optional field `sender_group_ids?: string[]`.
  - `applyFilter` gains a `case "sender_in_group":` returning `email.sender_group_ids?.includes(f.value) ?? false`. Treat as an INCLUDE op (not in `EXCLUDE_OPS`).
  - Add `sender_in_group` to the `regex`-style skip list in `gmail-query-builder.ts` (no Gmail-native mapping).
- `src/lib/sync/process-message.ts` (or wherever `EmailForFilter` is built): before running filters, resolve `sender_group_ids` by querying `contact_group_members` joined to `contacts` where `contacts.user_id = <user>` and `lower(contacts.email) = lower(from_addr)`. Cache per run.
- Zod enums in `folder-chat.functions.ts` / `folder-chat.server.ts` gain `sender_in_group`; the AI prompt gets one sentence explaining it so the chat agent can suggest it.

Reprocess path (`src/lib/gmail/reprocess.functions.ts`) already reads the filter list — no change beyond the engine understanding the new op.

## UI

- `src/routes/_authenticated/settings.contacts.groups.tsx` (or wherever groups are managed today — reuse existing route): each group row gets a "Linked folder" combobox (folders for the current account, plus "None"). Saving calls `linkContactGroupToFolder`. Show a small helper: "Emails from members are auto-filed to this folder."
- Contacts page (`src/routes/_authenticated/contacts.tsx`): add a horizontal chip row above the list — one chip per group with member count. Clicking toggles a `groups` search param (comma-separated group ids) via `validateSearch` + `useNavigate`. When one or more chips are active, filter the contacts query to `id in (select contact_id from contact_group_members where group_id = any(:ids))` (intersection across chips if multi-select feels right — start with union / OR to match "chip" mental model). Chip row also shows an "All" reset.
- Folder editor: when a folder has a `sender_in_group` filter, render it as a labeled chip ("Sender in group: Clients") instead of the raw op/value, with a delete affordance. Filter builder gains a "Sender in group" condition type.
- CardDAV settings page copy update: mention that iOS groups sync both ways and that a Zerrow group can be linked to a folder from Contacts → Groups.

## Verification

- `src/lib/carddav/vcard.parse.test.ts`: add cases for `CATEGORIES` parsing (with escaped commas), Apple group vCard round-trip (build → parse), and unfolding of long member lists.
- New `src/lib/sync/filter-engine.group.test.ts`: `sender_in_group` matches when `sender_group_ids` contains the id, misses otherwise, and does NOT act as an exclude.
- New `src/lib/carddav/handlers.groups.test.ts` (integration-ish, mocking `supabaseAdmin`): PUT on a group vCard reconciles members; PUT on a contact with new CATEGORIES creates missing groups and adds membership; DELETE on group href removes the group.
- Manual: iPhone → create group "Clients", add 2 contacts → appears in Zerrow with both members; link to folder "Clients"; send test email from one member → auto-filed; toggle chip on Contacts page → list narrows.

## Out of scope

- Group colors syncing to iOS (CardDAV has no standard for it).
- Cross-account group scoping — groups stay per-user, folder link references a specific `folders.id` which is already per-account.
- Bulk import of existing iOS groups on first connect beyond what a normal iOS sync sends (iOS pushes the full book).
