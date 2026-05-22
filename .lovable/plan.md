## Goal
On the contact detail page, make sure tapping a contact opens it reliably, then add a **Share contact** action with two channels: email (via the user's connected Gmail) and SMS (native `sms:` link with the contact's info prefilled).

## Scope
- `src/routes/_authenticated/contacts.tsx` — verify list rows are tappable on mobile (they already navigate via `<button onClick={navigate(...)}>`; only fix if a real bug is found during testing).
- `src/routes/_authenticated/contacts.$id.tsx` — add a "Share" button next to "Send my card" that opens a small dialog with two choices: Email and Text message.
- `src/lib/contacts.functions.ts` — new server function `shareContactByEmail` that sends the contact's vCard + summary via the user's connected Gmail.
- `src/lib/cards.server.ts` — small helper reuse: build a vCard string from arbitrary `CardData`-shaped input (already exists as `buildVCard`); add a sibling `sendContactShareEmail` that mails a vCard attachment + plain summary.

No schema changes, no new tables.

## UX

On contact detail (`/contacts/$id`), replace the single "Send my card" button area with two buttons:
- **Send my card** — unchanged, mails *your* card to the contact's email.
- **Share contact** — opens a dialog:
  - "Email" tab: input for recipient email (defaults to empty), optional note, **Send** button → calls `shareContactByEmail`.
  - "Text message" tab: input for phone number (prefilled with the contact's phone if present), preview of the SMS body, **Open Messages** button → `window.location.href = "sms:<number>?body=<encoded>"`.

SMS body format (kept short for carrier limits):
```
{name} — {title} at {company}
{email}
{phone}
{website}
Sent from Zerrow
```

Email format:
- Subject: `Contact: {name or email}`
- Body (HTML): name, title, company, email, phone, website, LinkedIn, Twitter — plus a brief "shared from Zerrow" footer.
- Attachment: `{name}.vcf` built via `buildVCard`.

## Server function

```ts
// src/lib/contacts.functions.ts
export const shareContactByEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    contactId: z.string().uuid(),
    toEmail: z.string().email(),
    note: z.string().max(2000).optional(),
  }).parse)
  .handler(async ({ data, context }) => {
    // 1. Load contact (RLS-scoped via context.supabase)
    // 2. Look up first gmail_account for this user
    // 3. Build vCard from contact fields
    // 4. sendContactShareEmail({ accountId, fromEmail, toEmail, contact, note })
  });
```

`sendContactShareEmail` mirrors the shape of `sendCardEmail` in `cards.server.ts` (Gmail API via the user's stored account) but with the contact as subject and a `.vcf` attachment.

## Tap-to-open verification
The list already wires `onClick={() => navigate({ to: "/contacts/$id", params: { id: c.id } })}` on a real `<button>`. If during testing tapping doesn't open the detail page on mobile, it's likely because the previously added mobile group-pill scroller overlays touches — I'll inspect and fix only if reproducible.

## Out of scope
- A public shareable URL for a contact (would need new schema + slugs).
- Multi-recipient sharing.
- Sharing from the contacts list (only from the detail page).

## Verification
1. On mobile viewport: tap a contact row → detail page opens.
2. Click **Share contact → Email**, enter a test address, send → toast success; check that recipient receives an email with `.vcf` attachment.
3. Click **Share contact → Text message** → opens Messages app with prefilled number + body.
