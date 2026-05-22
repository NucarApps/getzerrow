## 1. Fix contact rows not opening

`src/routes/_authenticated/` currently has:
- `contacts.tsx` (list)
- `contacts.$id.tsx` (detail)
- `contacts.scan.tsx` (scan)

With TanStack's flat dot routing, `contacts.tsx` is the **parent layout** for `contacts.$id` and `contacts.scan`. Because the list file doesn't render `<Outlet />`, navigating to `/contacts/:id` matches but only the list keeps rendering — so taps appear to do nothing.

**Fix:** rename `src/routes/_authenticated/contacts.tsx` → `src/routes/_authenticated/contacts.index.tsx`. That makes the three files siblings, and `/contacts/:id` will render the detail page on its own. No content changes to the list itself.

## 2. Actually delete the 752 inbox-imported contacts

Re-run the cleanup as three separate single-statement deletes (the previous combined statement didn't commit):

```sql
DELETE FROM contact_group_members
 WHERE contact_id IN (SELECT id FROM contacts WHERE source = 'email');
```
```sql
DELETE FROM contact_cards_sent
 WHERE contact_id IN (SELECT id FROM contacts WHERE source = 'email');
```
```sql
DELETE FROM contacts WHERE source = 'email';
```

Manually-added and scanned contacts (source `'scan'` or `'manual'`) are not touched.

## Out of scope
- No other code or UI changes.
