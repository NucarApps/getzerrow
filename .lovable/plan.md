## Goal

Add an iPhone-native CardDAV account you can add once under **Settings → Contacts → Accounts → Add Account → Other → CardDAV**. It shows all your Zerrow contacts as a "Zerrow" address book and refreshes automatically. One-way: Zerrow → iPhone. Edits on the phone stay local.

## How it works

CardDAV is HTTP + `PROPFIND` / `REPORT` / `GET`. iOS discovers the address book, downloads a vCard per contact, and re-checks periodically. We serve it read-only from a stable Lovable URL, so nothing needs to be installed on the phone besides adding the account.

## What you'll do once on the phone

1. In Zerrow → **Settings → CardDAV sync**, click "Generate iPhone password". You get a server URL, a username (your Zerrow email), and a one-time-shown password.
2. On iPhone: Settings → Contacts → Accounts → Add → Other → Add CardDAV Account → paste the three fields.
3. Done. Zerrow contacts appear in the Contacts app and refresh in the background.

## Scope

- **All your Zerrow contacts**, one address book called "Zerrow".
- **Fields:** name, company, title, all emails, phone, website, address, notes, LinkedIn/Twitter as URLs, photo when we have one.
- **Read-only:** the iPhone account is set to prevent phone-side edits (or we reject writes with `403`, whichever iOS honors best per field).

## Auth

- Basic auth over HTTPS (iOS requirement — CardDAV has no OAuth path).
- Username = your Zerrow account email. Password = a random 24-char token you generate in Settings, stored **hashed** in a new `carddav_tokens` table. You can revoke/rotate any time; old iPhones stop syncing until you re-enter the new password.
- Never accept your real Zerrow login password here.

## Endpoints (all under `src/routes/api/public/carddav/`)

CardDAV needs a specific URL tree. iOS auto-discovers from any of them:

```text
/.well-known/carddav                              → 301 to /api/public/carddav/
/api/public/carddav/                              → principal discovery
/api/public/carddav/principals/$userId/           → points to address book home
/api/public/carddav/addressbooks/$userId/         → lists "default" book
/api/public/carddav/addressbooks/$userId/default/ → the address book
/api/public/carddav/addressbooks/$userId/default/$contactId.vcf → one contact
```

Methods: `OPTIONS`, `PROPFIND` (depth 0/1), `REPORT` (`addressbook-query`, `addressbook-multiget`, `sync-collection`), `GET`. All XML — we hand-render the small set of responses iOS actually reads. Auth verified on every request.

## Change detection

- Each contact gets an **ETag** = short hash of its updated_at + key fields.
- Address book has a **CTag** = max(updated_at) across the user's contacts.
- `sync-collection` returns only changed/deleted contacts since the sync-token iOS sends → fast incremental refresh, low battery.
- Deleted contacts: add `deleted_at` to `contacts` (soft delete) so `sync-collection` can report tombstones. If you'd rather not soft-delete, the fallback is a periodic full re-sync — works but heavier.

## vCard mapping (VCARD 3.0, what iOS parses most reliably)

```text
FN, N            → contact.name
ORG, TITLE       → company, title
EMAIL;TYPE=…     → email (+ any additional from contact_emails if present)
TEL;TYPE=…       → contact_phones rows
ADR              → address_line1/2, city, region, postal_code, country
URL              → website
X-SOCIALPROFILE  → linkedin, twitter
NOTE             → notes (decrypted server-side per request)
PHOTO;ENCODING=b → avatar_url fetched + base64-inlined when available
UID              → contact.id (stable across syncs)
REV              → updated_at
```

Notes/phone/address are stored encrypted, so the CardDAV handler decrypts per-request via the existing `EMAIL_ENC_KEY` RPCs — same path the app uses. No plaintext ever lands in a new table.

## Database

New migration:

- `carddav_tokens` — `user_id`, `label`, `token_hash`, `last_used_at`, `revoked_at`. RLS scoped to `auth.uid()`. GRANTs for `authenticated` + `service_role`.
- `contacts.deleted_at` (nullable timestamptz) + partial index. All existing queries add `deleted_at IS NULL`. Delete API becomes soft-delete.
- `has_contact_carddav_access(_user_id, _token)` SECURITY DEFINER function so the public route can verify without RLS gymnastics.

## Server code

- `src/lib/carddav/` — `xml.ts` (tiny XML builder, no library), `vcard.ts` (contact → vCard), `auth.server.ts` (Basic auth → user_id), `handlers.server.ts` (PROPFIND/REPORT/GET dispatch).
- `src/routes/api/public/carddav/$.ts` — splat route handling all methods. `OPTIONS` returns `DAV: 1, 3, addressbook` header (iOS refuses to talk otherwise).
- `src/routes/api/public/.well-known/carddav.ts` — 301 redirect for auto-discovery.

## UI

- New card in **Settings → Integrations → CardDAV sync**:
  - "Generate iPhone password" button → modal shows server URL, username, password **once** with copy buttons + step-by-step iPhone instructions.
  - Table of active tokens (label, created, last used, Revoke).
- Server function: `createCarddavToken`, `revokeCarddavToken`, `listCarddavTokens`.

## Limitations to set expectations

- **One-way only.** If you edit a contact on the iPhone, it won't come back — the address book is read-only.
- **No groups yet.** All contacts land in one "Zerrow" book. Groups can come later if useful.
- **Photos** only if `avatar_url` is populated; base64 inlining is size-capped at ~256KB per contact so sync stays fast.
- **iOS-tested only.** macOS Contacts and Android DAVx⁵ will likely also work since it's spec-compliant, but iPhone is the target.

## Out of scope

- Two-way sync, group filtering, calendar (CalDAV), starred-only sync — easy follow-ups once the base works.
