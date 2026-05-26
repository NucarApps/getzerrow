## Goal

Let contacts store a postal address and multiple labeled phone numbers, and surface that in the contact card UI and the business-card scan flow.

## Quick clarification

"Save an address to a card" — I'm reading this as the **contact card** (the per-contact detail page at `/contacts/$id`). Your personal **My Card** (`/my-card`) is a separate thing and currently also has a single `phone` field. Tell me if you want this same treatment applied there too; otherwise I'll keep My Card unchanged for now.

## Data model

**`contacts` table — add address fields** (single address per contact):
- `address_line1` text
- `address_line2` text
- `city` text
- `region` text (state/province)
- `postal_code` text
- `country` text

**New `contact_phones` table** (multiple phones per contact, labeled):
- `id`, `user_id`, `contact_id` (cascade delete with contact)
- `label` text — `mobile` | `work` | `home` | `other` (free text allowed)
- `number` text (stored as user-entered; we'll trim + cap at 60 chars)
- `is_primary` boolean — exactly one primary per contact (enforced by partial unique index)
- `position` int — for stable ordering
- `created_at`, `updated_at`
- RLS: `auth.uid() = user_id`

**Migration of existing data:** copy each contact's current `contacts.phone` value into a `contact_phones` row labeled `mobile`, `is_primary = true`. Keep the `contacts.phone` column for now as a convenience mirror of the primary phone (kept in sync by the update fn) so the inbox/My Card and any AI prompts don't break. We can drop it in a later pass.

## Server functions (`src/lib/contacts.functions.ts`)

- Update `getContact` / `listContacts` selects to include the new address fields and `contact_phones` (left join, ordered by `position`).
- Update `updateContact` zod schema + handler to accept `address_*` fields and a `phones: { label, number, is_primary }[]` array. Replace-all strategy for phones inside a single transaction (delete-then-insert) to keep it simple and atomic; re-sync `contacts.phone` to the primary.
- Update the AI-extraction prompts/return shapes (`enrichContact`, scan-card OCR, signature parser) to return `phones[]` and `address` so we don't lose multi-phone data the model already finds. Output schema becomes `{ phones: [{label,number}], address: {...} }` in addition to existing fields.

## UI

**`src/components/contacts/ContactDetailView.tsx`**
- Replace the single Phone input with a `PhonesEditor` sub-component: list of rows (label select + number input + "Make primary" + remove), plus "Add phone" button.
- Add an Address section: 6 inputs in a 2-column grid (line1, line2, city, region, postal, country).
- The existing "Send to phone number" SMS panel switches to a dropdown of the contact's phones (defaulting to primary).
- Surface address in the read-only header view as a formatted block.

**`src/routes/_authenticated/contacts.scan.tsx`**
- Scan draft type gains `phones: {label, number}[]` and `address`.
- Render multiple phone rows + an address block in the review step; user can edit/remove before saving.

**My Card (`my-card.tsx`)** — unchanged unless you confirm you want the same.

## Validation

- Phone `number`: trim, `max(60)`, `min(3)`, allow `+`, digits, spaces, `()` and `-` only.
- `label`: trim, `max(20)`, enum-suggested but free-text accepted.
- Address fields: each trimmed, `max(120)` (country `max(60)`).
- Server zod schemas mirror client; reject empty phones array entries.

## Files touched

- New migration: schema + data backfill
- `src/lib/contacts.functions.ts` — schema, get/list/update, AI prompts
- `src/components/contacts/ContactDetailView.tsx` — phones editor + address section
- `src/routes/_authenticated/contacts.scan.tsx` — multi-phone + address in scan review
- New small component: `src/components/contacts/PhonesEditor.tsx`

## Out of scope

- My Card multi-phone/address (ask if you want it)
- Phone validation against a country library (kept lightweight)
- Geocoding the address