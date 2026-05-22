## 1. Remove inbox auto-import feature

**`src/routes/_authenticated/contacts.tsx`**
- Remove the `useEffect` that auto-runs `backfillContacts` when the list is empty.
- Remove the "Refresh" button in the header and the `rebuild()` handler.
- Drop the `backfillContacts` import, `build`, and `building` state (use only `q.isLoading` for the skeleton).
- Empty-state copy becomes: "No contacts yet. Scan a card or add one manually."

**`src/lib/contacts.functions.ts`**
- Delete the `backfillContacts` server function (and any helper it uses that's not referenced elsewhere, e.g. inbox-scanning utilities). Keep `listContacts`, `getContact`, `shareContactByEmail`, and scan/manual-add functions intact.

## 2. Delete the 752 auto-imported contacts

Run a data delete (via the insert tool) for the current user:
```sql
DELETE FROM contact_group_members
 WHERE contact_id IN (SELECT id FROM contacts WHERE source = 'email');
DELETE FROM contact_cards_sent
 WHERE contact_id IN (SELECT id FROM contacts WHERE source = 'email');
DELETE FROM contacts WHERE source = 'email';
```
This wipes all email-sourced contacts globally (only your account has any) and cleans up group memberships + share log rows that reference them. Manually-added and scanned contacts are preserved.

## 3. Fix mobile horizontal overflow on the contacts list

Root cause candidates on `/contacts`:
- The mobile groups pill scroller uses `-mx-4 px-4`, which is fine, but the parent doesn't clamp overflow — long group names or many pills can push the page wider than the viewport on iOS.
- The list rows render `c.email` / `c.company` in flex children without `min-w-0` on every level, so very long emails can blow out the row width.

Changes in `src/routes/_authenticated/contacts.tsx`:
- Add `overflow-x-hidden` (or `min-w-0`) on the outer scroll container so nothing escapes the viewport.
- Ensure the grid wrapper (`grid gap-6 md:grid-cols-[220px_1fr]`) has `min-w-0` and that the right column (`<div>` containing search + list) also has `min-w-0` so flex/grid truncation works.
- The `<ul>` list items: the inner `<button>` already has `min-w-0` on the text wrapper; double-check the button itself doesn't force horizontal scrolling on small screens and add `min-w-0` where missing.
- Make the mobile pill scroller container `max-w-full overflow-hidden` so the inner `overflow-x-auto` scroller is the only thing that can scroll horizontally.

## Out of scope
- Touching the contact detail page beyond what's needed.
- Any change to inbox/email features themselves.
