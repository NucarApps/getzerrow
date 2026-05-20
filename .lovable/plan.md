## Goal

Rename the sidebar entry **Unsorted** → **No rules** and change its meaning to: every email that has **no folder assigned** in the app AND **no user-created Gmail label** in `raw_labels`, regardless of read/archived state. These are emails Gmail just dropped into the archive with nothing routed to them.

## Definition of "no user labels"

Gmail system label ids: `INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`, `SENT`, `DRAFT`, `SPAM`, `TRASH`, `CHAT`, `CATEGORY_*`. User-created labels always have ids that start with `Label_`.

So a row qualifies for "No rules" when:

```
folder_id IS NULL
AND NOT EXISTS l ∈ raw_labels WHERE l LIKE 'Label\_%'
```

## Changes

### 1. `src/lib/folder-selection.tsx`
Change the union type:
```ts
export type FolderSelection = string | "all" | "no_rules";
```
(Renaming `"unsorted"` → `"no_rules"` everywhere — it's an internal key, no migration needed.)

### 2. `src/routes/_authenticated.tsx` (sidebar)
- Replace the `"Unsorted"` `FolderRow` with `label="No rules"`, key `"no_rules"`, same muted color.
- Update the counts builder (~line 106–120): a row counts toward `no_rules` when `folder_id IS NULL` AND `!raw_labels?.some(l => l.startsWith("Label_"))`. Include both read and unread.
  - Also update `emailsQ` (~line 93–103) to fetch `raw_labels` and drop the `is_read=false` filter so the count reflects read + unread. (Bump `limit` only if needed; 5000 stays.)
- The "All inbox" total stays as today (unread, not archived).

### 3. `src/routes/_authenticated/index.tsx` (email list query)
Line 125 currently does:
```ts
else if (selectedFolder === "unsorted") q = q.eq("is_archived", false).is("folder_id", null);
```
Replace with the `no_rules` branch:
```ts
else if (selectedFolder === "no_rules") {
  q = q.is("folder_id", null);
  // user-label filter applied client-side (see below)
}
```
Postgres array filtering with a `LIKE` predicate isn't expressible through PostgREST, so after `await q` we filter the returned rows:
```ts
let rows = (data ?? []) as Email[];
if (selectedFolder === "no_rules") {
  rows = rows.filter(e => !(e as any).raw_labels?.some((l: string) => l.startsWith("Label_")));
}
```
To keep pagination predictable, bump the per-page fetch when on `no_rules` (e.g. `limit(PAGE_SIZE * 3 + 1)`) and slice to `PAGE_SIZE` after filtering. Cursor still uses the last returned row's `received_at`. Acceptable trade-off — most users have very few user labels, so filter loss is small.

Also update `labelForFolder` (~line 544–548): `if (sel === "no_rules") return "No rules";`.

### 4. Search for any other `"unsorted"` references
`MoveSimilarDialog.tsx` line 48 uses the string `"Unsorted"` as a display fallback for "no folder assigned" — change that copy to `"No rules"` so the label stays consistent across the UI.

## Not changing

- No DB schema changes, no migrations.
- No server functions added — the existing `supabase.from("emails")` query path stays.
- Sync / classification logic unchanged.
- "All inbox" semantics unchanged.

## Risk / edge cases

- Client-side label filtering means a heavily-labeled mailbox could see fewer than `PAGE_SIZE` rows per page even after the 3× overfetch. If that turns out to matter we can promote this to a `createServerFn` with a raw SQL `NOT EXISTS (SELECT 1 FROM unnest(raw_labels) l WHERE l LIKE 'Label\_%')`. Left out for now to keep the change small.
- Sidebar count is approximate — it's bounded by the existing 5000-row `emailsQ` fetch, same as today.
