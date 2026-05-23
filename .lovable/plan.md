## Goal

When **By company** is on, sort the company buckets **alphabetically by company name** (A → Z) instead of by contact count.

## Change

In `src/routes/_authenticated/contacts.index.tsx`, the `companyBuckets` memo currently sorts company buckets by contact count descending and uses name only as a tiebreaker:

```ts
.sort((a, b) => b.contacts.length - a.contacts.length || a.name.localeCompare(b.name));
```

Replace with case‑insensitive alphabetical sort on the bucket's display name:

```ts
.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
```

Keep **Personal email** and **Other** buckets pinned at the bottom (unchanged).

No other changes — flat view, collapse behavior, and color tinting stay as-is.
