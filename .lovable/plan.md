# Fix login-page flash on refresh when signed in

## Root cause
`src/routes/_authenticated.tsx` does the auth check in `beforeLoad`:

```ts
beforeLoad: async () => {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw redirect({ to: "/login" });
}
```

This runs during SSR too. The Supabase session is stored in browser `localStorage`, which doesn't exist on the server, so `getSession()` always returns `null` on the server. Result: the server renders/redirects to `/login`, ships that HTML, then the client hydrates, finds the real session, and finally navigates to `/inbox`. The user sees `/login` for a beat.

## Fix
Skip the auth gate during SSR and run it only on the client, where the session actually exists. Also add a symmetric guard on `/login` so a logged-in user landing on the login page gets sent to `/inbox` without a flash.

### `src/routes/_authenticated.tsx`
Change `beforeLoad` to no-op on the server:

```ts
beforeLoad: async () => {
  if (typeof window === "undefined") return; // session lives in localStorage
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw redirect({ to: "/login" });
},
```

### `src/routes/login.tsx`
Add a `beforeLoad` that redirects authenticated users straight to `/inbox` on the client, so even on a hard refresh of `/login` they don't see the form:

```ts
export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data } = await supabase.auth.getSession();
    if (data.session) throw redirect({ to: "/inbox" });
  },
  component: LoginPage,
});
```

The existing `onAuthStateChange` effect in `LoginPage` stays as-is for the OAuth callback path.

## Result
- Refreshing `/inbox` while signed in: SSR renders the inbox shell, client hydrates with the real session, no detour through `/login`.
- Refreshing `/login` while signed in: client redirect to `/inbox` before render.
- Signed-out users on protected routes still get redirected to `/login` on the client (the brief shell render is acceptable — they're unauthenticated and have no data to leak).
