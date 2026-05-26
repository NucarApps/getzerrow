# Make "All Inbox" mirror Gmail's INBOX label

## Goal
"All Inbox" should show every email that has Gmail's `INBOX` label — even if it's also routed to a Zerrow folder. If you (or Gmail) remove the INBOX label (archive), it disappears from All Inbox and only shows up in All Mail.

## Why the change
Today "All Inbox" filters on `is_archived = false`. That column gets flipped to `true` by folder side-effects (`auto_archive`, `hide_from_inbox`) even when the email still has the INBOX label in Gmail. That's why foldered items disappear and the view doesn't match Gmail.

The fix is to switch the inbox view from `is_archived` to "raw_labels contains INBOX". `raw_labels` is already kept in sync by parse + reconcile + history poll, so it's the canonical Gmail state.

## Changes

### 1. `src/routes/_authenticated/inbox.tsx` — query filter
In the emails query (around line 423), replace:
```ts
if (selectedFolder === "all") q = q.eq("is_archived", false);
```
with:
```ts
if (selectedFolder === "all") q = q.contains("raw_labels", ["INBOX"]);
```

Per-folder selection (`folder_id = selectedFolder`) and All Mail stay as they are.

### 2. `src/lib/use-email-realtime.ts` — `rowBelongsInList`
Update the `"inbox"` tag branch so it matches the new rule:
```ts
if (tag === "inbox") {
  return Array.isArray(row.raw_labels) && row.raw_labels.includes("INBOX");
}
```
Add `raw_labels: string[] | null` to `EmailRow`. Update `rowBelongsInList` tests in `src/lib/realtime-belongs.test.ts` accordingly (inbox = raw_labels contains INBOX; folder_id no longer disqualifies).

### 3. Optimistic updates in `inbox.tsx`
A few mutation handlers patch `is_archived` to reflect "now archived / now in inbox". Update those to also patch `raw_labels` so the realtime cache filter agrees:
- Unarchive / move-to-inbox handlers (lines ~847, 875, 1435): set `raw_labels` to include `"INBOX"` (add if missing) alongside `is_archived: false`.
- Archive / move-to-folder handlers (lines ~899–907, 1124, 1346, 1478): set `raw_labels` to exclude `"INBOX"` alongside `is_archived: true`.

Small helper inside the file:
```ts
const withInbox = (labels: string[] | null | undefined) =>
  Array.from(new Set([...(labels ?? []), "INBOX"]));
const withoutInbox = (labels: string[] | null | undefined) =>
  (labels ?? []).filter((l) => l !== "INBOX");
```

### 4. Counts / labels
`labelForFolder` and badge counts that rely on the "all" query don't need changes — they read from the same query.

## Out of scope
- No schema changes.
- No change to "Archived" view, per-folder views, search, or All Mail.
- No change to `is_archived` writes in `process-message` / `reconcile` — that column still drives folder side-effects; we just stop using it as the inbox filter.
- No re-archiving of the emails restored by the previous override fix; they'll naturally drop out of All Inbox only if their INBOX label is gone in Gmail.

## Verification
- Open All Inbox: a foldered email that still has Gmail's INBOX label appears (previously hidden).
- Archive an email in Zerrow → disappears from All Inbox, appears in All Mail.
- Archive an email in Gmail directly → after next sync, disappears from All Inbox.
- Update `realtime-belongs.test.ts` and run `bunx vitest run src/lib/realtime-belongs.test.ts`.
