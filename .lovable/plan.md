## Why the 30–60s "Loading…" on reload

The sidebar's unread-counts query (in `src/routes/_authenticated.tsx`) runs on every page load:

```ts
supabase.from("emails").select("*").order("received_at", { ascending: false }).limit(2000)
```

It pulls **every column** of up to 2000 emails just to count unread per folder. With ~1017 emails and ~11 KB of `body_html`/`body_text` per row, that's roughly **11 MB** of JSON shipped over the network on every reload, every realtime invalidation, every tab focus, and every sync — exactly the "30–60 second blank screen" symptom.

The inbox search path (in `src/routes/_authenticated/index.tsx`) has the same problem: when `isSearching`, it does `select("*")` with `limit(2000)`.

Reloading is especially bad because `useEmailRealtime` invalidates `["emails"]` once on mount, once again when the channel subscribes, once again on visibility/focus — each invalidation re-runs the 11 MB query.

## Plan

1. **Sidebar counts query** — change `select("*")` to `select("id,folder_id,is_read,is_archived")`. Counts only need those 4 columns. This alone cuts the payload from ~11 MB to well under 100 KB.

2. **Inbox search query** — change the `isSearching` branch from `select("*")` to a slimmer column list (`id, from_addr, from_name, subject, snippet, received_at, is_read, is_archived, folder_id, ai_summary, thread_id, has_attachment`) — exclude `body_text` / `body_html`. The body is only needed when an email is opened; the detail pane already has its own fetch path or we add one on selection.

3. **Reduce redundant refetches on mount** — `useEmailRealtime` currently invalidates `["emails"]` immediately on mount AND again when the channel subscribes. Drop the mount-time invalidation; let the initial `useQuery` fetch do the first load, and only catch up after the channel is subscribed.

4. **Lower the refetch interval cost** — keep `refetchInterval: 30_000` on the inbox list (it's already paged to ~50 rows so it's cheap), but make sure neither the sidebar's counts query nor the search query carry that interval.

No backend / schema / functionality changes — this is purely fixing the over-fetching on the client.

### Files to edit
- `src/routes/_authenticated.tsx` — narrow the sidebar emails select.
- `src/routes/_authenticated/index.tsx` — narrow the search-mode emails select.
- `src/lib/use-email-realtime.ts` — remove the immediate post-subscribe invalidation on first mount.
