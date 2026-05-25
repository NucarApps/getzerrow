# Contact drawer + my-card website fix

## 1. Open contacts in a drawer instead of navigating

**Extract** the body of `src/routes/_authenticated/contacts.$id.tsx` (everything inside `ContactDetail` and the `ShareContactDialog`/`Field` helpers) into a new shared component:

- New file: `src/components/contacts/ContactDetailView.tsx`
  - Props: `{ id: string; onClose?: () => void; onDeleted?: () => void }`
  - Same logic as today (queries, enrich, save, share, groups), but no `<Link to="/contacts">` back button or page padding wrapper — those are owned by the parent (route or drawer).
  - On delete: call `onDeleted?.()` instead of `navigate({ to: "/contacts" })`.

- Update `src/routes/_authenticated/contacts.$id.tsx` to be a thin wrapper that renders `<ContactDetailView id={id} onDeleted={() => navigate({ to: "/contacts" })} />` inside the existing page chrome (back link + max-width container). This preserves direct URL access to `/contacts/:id` and SEO.

- New file: `src/components/contacts/ContactDrawer.tsx`
  - Wraps `ContactDetailView` in a shadcn `Sheet` (`side="right"`, `className="w-full sm:max-w-2xl overflow-y-auto"`).
  - Props: `{ contactId: string | null; open: boolean; onOpenChange: (v: boolean) => void }`.
  - On delete, closes the drawer and invalidates `["contacts"]`.

- Edit `src/routes/_authenticated/contacts.index.tsx`:
  - Add local state `const [drawerId, setDrawerId] = useState<string | null>(null)`.
  - Replace both `navigate({ to: "/contacts/$id", params: { id: c.id } })` calls (lines 309, 349) with `setDrawerId(c.id)`.
  - Render `<ContactDrawer contactId={drawerId} open={!!drawerId} onOpenChange={(v) => !v && setDrawerId(null)} />` at the end of the page.

The standalone `/contacts/:id` route remains functional (deep links, share links still work).

## 2. Fix "Invalid input / Must be an http(s) URL" when saving My card

The error comes from `src/lib/cards.functions.ts` line 29 — the `website` field requires a strict `https?://` URL, so typing `getzerrow.com` or leaving the field with whitespace fails Zod parsing.

Fix in **two places**:

- `src/routes/_authenticated/my-card.tsx` (`save()` handler): normalize before sending — trim, return `null` if empty, otherwise prepend `https://` if no `http(s)://` prefix is present.
- `src/lib/cards.functions.ts` (`updateMyCard` validator): mirror the normalization server-side via a `z.preprocess` so any caller (including future ones) gets the same behavior. Keep the final shape `.url().max(500).nullable().optional()` but drop the redundant `https?://` regex (the preprocess guarantees it).

No other field validation changes.

## Out of scope

- No changes to contacts list layout, grouping, search, or routes.
- No changes to the contact detail's business logic (enrich, share, groups, delete).
- No DB/RLS changes.
