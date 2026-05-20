## What's already there

Two realtime channels exist — one in `src/routes/_authenticated.tsx` (sidebar) and one in `src/routes/_authenticated/index.tsx` (inbox). Both subscribe to `postgres_changes` on `public.emails` and `public.folders`. The tables are in the `supabase_realtime` publication and have `REPLICA IDENTITY FULL`, so the database side is correctly wired.

So why does it still feel stale? A few likely culprits:

1. **Two channels racing.** Both subscribe to the same tables. If one fails to connect (websocket auth race, tab throttling, sleep), the other might or might not be alive. Behavior becomes inconsistent.
2. **No reconnect on auth/visibility changes.** When the browser tab is backgrounded, the websocket can drop. When it wakes, missed events are gone forever — there's no catch-up unless we refetch.
3. **No realtime auth refresh.** If the channel was opened before the Supabase session was hydrated, RLS filters out every payload server-side and the client silently receives nothing.
4. **External writes via the webhook/cron** (`gmail-webhook`, `gmail-poll`, AI classifier) use the service-role admin client — these DO trigger postgres replication, so they should fire `postgres_changes`. If realtime auth is broken, they're filtered out by RLS.

## Plan

Consolidate to a single, resilient realtime layer plus a focus/visibility fallback so the inbox is always within a couple seconds of the database.

### 1. One root-level realtime subscription

Move both channels into a single `useEmailRealtime` hook mounted in `_authenticated.tsx`. Remove the duplicate subscription in `_authenticated/index.tsx`. The hook:

- Subscribes to `postgres_changes` on `emails` and `folders` filtered by `user_id=eq.<current uid>` to reduce noise.
- On every event, calls `qc.invalidateQueries({ queryKey: ["emails"] })` and (for folder events) `["folders"]` / `["folders-full"]`.
- Logs `subscribe` status to the console once so we can confirm connection in the user's preview.

### 2. Re-auth the realtime socket on auth changes

Inside the hook, on mount and inside `supabase.auth.onAuthStateChange`, call `supabase.realtime.setAuth(session.access_token)` so RLS sees the user. Tear down and re-create the channel when the access token rotates.

### 3. Catch-up refetch on tab focus / visibility

Add a small effect that listens to `visibilitychange` and `focus`. When the tab becomes visible again, call `qc.invalidateQueries({ queryKey: ["emails"] })` and `["folders"]`. This covers the "laptop was asleep, websocket dropped, missed 12 events" case without waiting for the user to click refresh.

### 4. Light periodic safety net

Set `refetchOnWindowFocus: true` and `refetchInterval: 30_000` on the `["emails"]` query as a belt-and-suspenders fallback. Cheap (single indexed query), invisible to the user, and guarantees the inbox is never more than ~30s stale even if realtime is completely broken.

### 5. Optimistic local updates for the actor

When the current user archives, trashes, marks read/unread, or moves an email, update the React Query cache immediately (we already do this for mark-read) so the row flips before the server round-trip completes. Realtime then reconciles. This is the only way "feels instant" actions stay instant.

## Files

- `src/lib/use-email-realtime.ts` (new) — the consolidated hook with channel + visibility + auth-refresh.
- `src/routes/_authenticated.tsx` — replace inline `useEffect` channel with the hook.
- `src/routes/_authenticated/index.tsx` — delete the duplicate channel; add `refetchOnWindowFocus` + `refetchInterval` to `emailsQ`; add optimistic cache updates inside the archive/trash/move/mark handlers in `Reader`.

## What I'm not changing

- The webhook / cron / sync server-fn code. Those already write through `supabaseAdmin` which triggers replication correctly; the gap is on the client.
- The DB schema, RLS, or publication. All three are already correct.
