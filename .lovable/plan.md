## Goal

In the Contacts list, when a company bucket (e.g. Chevrolet) is expanded, stop showing each person's email under their name. Instead show their **job title** and a **short blurb** describing who they are.

## Changes

**1. `src/lib/contacts.functions.ts` — `listContacts`**
- Add `relationship_summary` to the `.select(...)` columns so the list query returns the existing AI-generated blurb alongside `title`.

**2. `src/components/contacts/CompanyAliasesDialog.tsx`** — no changes.

**3. `src/routes/_authenticated/contacts.index.tsx`** — expanded company rows only
Currently each row renders:
```
{name or email}
{email}              ← muted subline
```
Change to:
```
{name or email}
{title}              ← muted subline (falls back to email only if no title)
{relationship_summary}   ← 2-line clamped, smaller, only if present
```
- Use `line-clamp-2` for the blurb, `text-xs text-muted-foreground/80`.
- Only applies inside the `groupByCompany` branch's company buckets. Personal / Other buckets keep the existing email subline (no company context there).
- The plain ungrouped list view (when "By company" is off) is untouched.

## Out of scope
- Generating new summaries — uses whatever `relationship_summary` already exists.
- Changing the contact drawer / detail view.
- Adding a company-level blurb (the request reads as per-person "who they are"; happy to add a company description on the bucket header in a follow-up if that's what you meant).
