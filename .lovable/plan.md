## What's happening

On a hard refresh while signed in, the page is slow and you sometimes land on `/login`. The `Uncaught undefined` and the bounce-to-login both trace back to how we check auth on boot.

### Root causes

1. **`_authenticated.beforeLoad` calls `supabase.auth.getUser()`.** That is a network round-trip to Supabase Auth on *every* navigation/refresh. On a cold refresh it can be slow, and if it ever returns `null` (token expired-then-refreshing, or transient network blip), we throw `redirect({ to: "/login" })` — so the signed-in user gets bounced out. The correct primitive for a guard is `getSession()`, which reads from localStorage synchronously after the SDK hydrates and doesn't hit the network.

2. **Auth-state subscribers fire on every event, including `INITIAL_SESSION` and `TOKEN_REFRESHED`.** We have two of them:
   - `AuthSync` in `__root.tsx` → calls `router.invalidate()` + `queryClient.invalidateQueries()` (re-runs every loader + every query).
   - `useEmailRealtime` in `_authenticated.tsx` → tears down and rebuilds the realtime channel.

   On boot Supabase fires `INITIAL_SESSION` and then (often) `TOKEN_REFRESHED`. That triggers two full loader/query re-runs plus a realtime reconnect, layered on top of the initial render — that's the slowness. It's also a likely source of the `Uncaught undefined`: an in-flight server-fn promise gets aborted/orphaned by `router.invalidate()` and the rejection value (a TanStack `redirect` object) bubbles up unhandled.

### Fix

**`src/routes/_authenticated.tsx`** — swap `getUser()` for `getSession()`:
```ts
beforeLoad: async () => {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw redirect({ to: "/login" });
}
```
Fast, offline-safe, and doesn't false-bounce when a token is mid-refresh.

**`src/routes/__root.tsx` (`AuthSync`)** — only invalidate on real sign-in/sign-out, not on every token refresh or the boot `INITIAL_SESSION`:
```ts
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN" || event === "SIGNED_OUT") {
    router.invalidate();
    qc.invalidateQueries();
  }
});
```

**`src/lib/use-email-realtime.ts`** — same filter for the channel rebuild:
```ts
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN" || event === "SIGNED_OUT") { teardown(); connect(); }
});
```
(Token refreshes are handled by `supabase.realtime.setAuth` inside `connect`; we don't need to drop and rebuild the channel for them.)

### Out of scope
- No changes to login flow, the new context menu, the `addInboxOverride` server fn, or any UI.
- No source-map / deployment changes; if `Uncaught undefined` persists after this fix, I'll add a global `unhandledrejection` listener to print the stack and we can diagnose further.
