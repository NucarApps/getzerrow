## Problem

When a contact was created from a phone-only source (e.g. Google Contacts with no email), the email field in the contact detail edit view is rendered `disabled`, so there's no way to add or correct an email address for that contact.

Two blockers:

1. `src/components/contacts/ContactDetailView.tsx` (line 420) hardcodes `<Input value={c.email} disabled />` — the email is always read-only.
2. `updateContact` in `src/lib/contacts/crud.functions.ts` does not accept an `email` field, so even if the UI were editable the server would silently drop it.

## Fix

1. **Server (`src/lib/contacts/crud.functions.ts`)**
   - Add `email` to the `updateContact` Zod schema: accept `string` or `null`, trim + lowercase + `.email()` when non-empty, treat empty string as `null`, max 255.
   - Include `email` in the update payload when the caller sent the key.
   - Wrap the update in a try/catch that translates Postgres unique-violation `23505` on `contacts_user_email_unique` (or the partial index) into a friendly error: "Another contact already uses this email."

2. **UI (`src/components/contacts/ContactDetailView.tsx`)**
   - Replace the disabled email input with an editable one that lives in the same edit-mode state pattern used by name/title/company (existing pencil-toggled edit flow).
   - In view mode: show the email (or a muted "Add email" affordance when null).
   - In edit mode: an `<Input type="email">` bound to a local `emailDraft` state; on save, include `email` (nulled out when blank) in the `update({ data: { id, ...patch, email } })` call.
   - Optimistic invalidate as with the other fields; on error, show the toast returned from the server (covers the duplicate-email case).

No schema migration is needed — the `contacts` table already allows nullable email with a partial unique index on `(user_id, email) WHERE email IS NOT NULL`.

## Out of scope

- No changes to Google Contacts push/pull mapping (email round-trip already works there).
- No changes to CardDAV mapping.
- No changes to the bulk contacts list, only the single-contact detail view where the pencil icon lives.

## Verification

Open a phone-only contact, click the pencil next to email, type an address, save. Row updates; reload shows the new email; entering a duplicate shows the friendly error instead of a raw Postgres message; clearing the field saves as null.
