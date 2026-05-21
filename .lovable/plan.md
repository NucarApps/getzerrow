## Problem

On mobile, opening the drawer and tapping **Settings** does nothing — the drawer closes (or doesn't) and the route never changes to `/settings`.

## Cause

In `src/routes/_authenticated.tsx` the Settings link inside the mobile `Sheet` does:

```tsx
<Link to="/settings" onClick={() => onNavigate?.()}>
```

`onNavigate` calls `setMobileOpen(false)` synchronously. Radix's `Sheet` (Dialog) starts its close transition immediately, which unmounts the link's portal-adjacent focus trap and, on touch devices, can swallow the click before TanStack Router's own `onClick` handler runs. Net effect on mobile: the sheet closes and navigation is dropped. The Inbox link "works" only because it also calls `pick("all")` which calls `navigate({ to: "/inbox" })` programmatically — so navigation happens regardless of the Link click.

## Fix

Make navigation explicit and run it before closing the sheet, mirroring the pattern already used by the folder rows.

In `src/routes/_authenticated.tsx`, change the Settings entry from a `<Link>` to a button that calls `navigate({ to: "/settings" })` and then `onNavigate?.()`. Keep the active styling by reading `pathname` (already available via `useRouterState`) and applying the active class manually.

Apply the same treatment to the Inbox link for consistency (it already navigates via `pick`, but moving it off `<Link>` removes the latent race) — and to the inline "Connect Gmail in Settings" link further down, which has the same bug.

## Files touched

- `src/routes/_authenticated.tsx` — replace the two sidebar `<Link>` items and the inline Settings link with button/`onClick` navigations. ~15 lines changed.

## Out of scope

- No styling redesign of the sidebar.
- No changes to desktop behavior (works the same because there is no sheet to close).
- No changes to routes, server functions, or auth.

## Verification

1. On mobile viewport, open the drawer, tap **Settings** → drawer closes and `/settings` loads.
2. On mobile, tap **Inbox** → drawer closes and `/inbox` loads.
3. On desktop, both links still work and show the active state on the current route.
