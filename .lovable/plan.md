## Goal

Make the `/admin` page viewable only by you (`chris@nucar.com`). Your admin data is already secure — the gap is that any signed-in user briefly sees the empty admin shell before being redirected. This plan closes that gap by checking admin status before the page renders.

## Current state

- **Data is already protected.** Every admin server function (`getAdminMe`, `listAdminUsers`, `getAdminActivity`) runs `assertAdmin`, which throws `403 Forbidden` for anyone whose token email isn't `chris@nucar.com`. No other user can load the users list, stats, or activity.
- **The page chrome is not gated.** The route's `beforeLoad` only checks "is this user logged in." So a signed-in non-admin who visits `/admin` renders the page skeleton, the `getAdminMe` request then fails, a toast fires, and they get redirected to `/inbox`. That brief flash is the only real issue.

## What changes

Add an admin check to the route's `beforeLoad` in `src/routes/_authenticated/admin.tsx` so non-admins are redirected away **before** the component ever renders — no flash, no empty shell.

1. In `beforeLoad`, after confirming the user is signed in, call the existing `getAdminMe` server function (which returns the email for admins and `403` for everyone else).
2. If `getAdminMe` throws (non-admin), `throw redirect({ to: "/inbox" })` directly from `beforeLoad`.
3. Remove the now-redundant component-level `accessDenied` redirect (the `meQ.isError` → `navigate("/inbox")` block) and its toast, since the gate now happens earlier. Keep the `getAdminMe` query if convenient for showing "Signed in as …", or reuse the `beforeLoad` result via route context.

The admin email stays hardcoded as `chris@nucar.com` in `src/lib/admin.functions.ts` (no change there).

## Technical details

- `beforeLoad` in this `_authenticated` subtree runs client-side (`ssr: false` layout), after the Supabase session is available, so the bearer token is attached to the `getAdminMe` call by the existing `attachSupabaseAuth` middleware.
- Wrap the `getAdminMe` call in try/catch; on any error, `throw redirect({ to: "/inbox" })`. Re-throw if it's already a redirect (use `isRedirect`) so the unauthenticated `/login` redirect still works.
- No database, RLS, or server-function changes are needed — the server-side `assertAdmin` remains the authoritative security boundary; this change is the UX/visibility layer on top of it.

## Out of scope

- No new admin-role table (you chose to keep the hardcoded email).
- No changes to what the admin page displays.
