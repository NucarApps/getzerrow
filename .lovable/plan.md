## Goal

Add a "Group by company" toggle to the Contacts page. Companies are derived from each contact's email domain (e.g. `acme.com`), and each company gets a logo fetched from a public logo service. The existing manual groups (Work, Personal, etc.) stay as-is.

## UX

On `/contacts`:
- Add a toggle in the toolbar (next to the search box): **Group by company** (off by default).
- When OFF: current flat list, unchanged.
- When ON: contacts are bucketed by company. Each bucket renders as a collapsible section:
  - Left: 32px rounded company **logo** (or a colored monogram fallback).
  - Title: inferred company name (prefer `contact.company` if any contact in the bucket has one, else a prettified domain like `acme.com` → "Acme").
  - Subtitle: domain + contact count.
  - Click header to collapse/expand. Click a contact row to open the existing detail page.
- Personal-mail domains (gmail.com, outlook.com, icloud.com, yahoo.com, hotmail.com, proton.me, etc.) collapse into a single **"Personal email"** bucket at the bottom so they don't pollute the company view.
- Contacts with no email domain go into an **"Other"** bucket.

The existing left rail (manual groups: All / Ungrouped / Work / …) keeps filtering the contact set first; the company grouping is applied on top of whatever is currently filtered.

Each contact row also gets a small company logo on the left (16–20px) when grouping is OFF, so the visual identity carries over to the flat view too.

## Logo source

Use **logo.dev** public endpoint — no key required for unauthenticated `img` requests, returns a 1×1 transparent pixel for unknown domains (good fallback), and is free for this kind of use:

```
https://img.logo.dev/{domain}?size=64&format=png&fallback=monogram
```

Loaded directly in an `<img>` tag (no server call, no API key). On `onError`, fall back to a colored circle with the company's first initial (matching the existing avatar style).

No new secrets, no new server functions, no new tables — purely client-side derivation and image loading.

## Technical changes

1. **`src/lib/company-domains.ts`** (new, tiny utility):
   - `PERSONAL_DOMAINS` set.
   - `extractDomain(email)` → lowercased domain or null.
   - `prettyCompanyName(domain)` → `acme.com` → "Acme", `mail.acme.co.uk` → "Acme".
   - `logoUrl(domain, size)` → logo.dev URL.

2. **`src/components/contacts/CompanyLogo.tsx`** (new):
   - Props: `domain`, `name`, `size`.
   - Renders `<img>` from logo.dev; on `onError` swaps to a monogram circle (reusing the existing primary/15 style).

3. **`src/routes/_authenticated/contacts.index.tsx`**:
   - Add `groupByCompany` boolean state and a `Toggle`/`Switch` button in the toolbar (lucide `Building2` icon).
   - Compute `companyBuckets` with `useMemo` from `filtered`: map domain → `{ domain, name, contacts[] }`, sort by contact count desc, then alphabetically; route personal-mail domains to a single "Personal email" bucket and place it last along with "Other".
   - Add a `Set<string>` of collapsed bucket keys; default all expanded.
   - When `groupByCompany` is on, render the buckets in place of the flat `<ul>`. Each section: header row (logo + name + count + chevron) and the existing contact rows underneath.
   - Add a small `<CompanyLogo>` to the flat row as well (replacing or sitting beside the current letter avatar).

4. **No DB / no server-function changes.** No new dependencies.

## Out of scope

- Persisting the toggle across sessions (can add later via localStorage if you want).
- Auto-filling `contacts.company` from the inferred name (kept as display-only so we don't overwrite scanned/edited data).
- Bulk "create a manual group from this company" action (easy follow-up if useful).

## Open question

Want me to also **persist** the inferred company name back to each contact's `company` field when it's empty, so it shows up in the detail view and exports? Default plan above does not touch the DB.
