## What's actually happening

Two issues, one root cause.

**1. Sidebar count vs. list mismatch**

`SidebarInner` (`src/routes/_authenticated.tsx`) counts unread using a **separate query** `["emails-summary"]` that selects `id, folder_id, is_read, is_archived` with `limit 2000`.

The inbox list (`src/routes/_authenticated/index.tsx`) uses `["emails"]` that selects `*` with `limit 500`.

These can disagree:
- An older email gets re-classified into a folder → it's in the 2000-row summary but outside the 500-row list. Sidebar shows "1", the list looks empty.
- One query refetches before the other after a realtime ping → momentary "1" with no row.

That's the "Factory shows 1, no new email when I click" symptom.

**2. Realtime "not updating"**

The realtime channels are wired correctly. What looks like "realtime is broken" is mostly the same divergence — the count refreshes (small query), the list doesn't catch up (or the new row isn't in its window). Gmail push → webhook → `syncSinceHistory` → DB insert is functioning (your `last_poll_at` is current and `watch_expiration` is valid), so inserts ARE happening; the client just isn't always reflecting them.

## Fix

Make the inbox list and the sidebar counts read from **one** query, and remove the row-count cap so we don't lose recent emails.

### `src/routes/_authenticated/index.tsx`
- No code change needed here for the count, but raise the list limit from 500 → 2000 to match the summary window (and avoid older-but-recently-classified emails dropping off).

### `src/routes/_authenticated.tsx` (`SidebarInner`)
- Delete the `emails-summary` query.
- Read counts from the existing `["emails"]` cache via `useQuery({ queryKey: ["emails"], … })` with the **same** queryFn the inbox uses, OR (cleaner) extract a tiny shared hook `useEmailsList()` that both files call. One in-flight request, one source of truth.
- The realtime handler in `_authenticated.tsx` already invalidates `["emails"]`, so the counts will tick in real-time too.

### Bonus reliability (small)
- In the inbox realtime handler, on INSERT also `refetchQueries({ queryKey: ["emails"] })` (force, don't just invalidate) so a brand-new email shows without waiting for window focus.

## Files changed

- `src/routes/_authenticated.tsx` — replace `emails-summary` query with a shared/reused `["emails"]` query; drop the old summary subscription branch.
- `src/routes/_authenticated/index.tsx` — bump `limit(500)` → `limit(2000)`; switch the realtime INSERT handler from `invalidateQueries` to `refetchQueries` for `["emails"]`.
- Optionally: `src/lib/use-emails.ts` (new, ~15 lines) — shared hook used by both files.

## Out of scope

- No backend changes, no schema changes, no edge function changes.
- Not touching Gmail watch / pubsub / polling — those are working.
- Not adding pagination yet; if you ever exceed ~2000 active emails we'll revisit with proper paging.
