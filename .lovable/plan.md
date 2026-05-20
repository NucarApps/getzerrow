## Bug

In `src/routes/_authenticated.tsx`, `SidebarInner` updates `selected` via `setSelected(f.id)` when you click a folder row. The Inbox page (`/`) reads that selection and re-renders, but **no route navigation happens**. So when you're on `/settings` and click "Factory notifications", the sidebar highlights it but the main panel stays on Settings.

The same bug affects clicking "All inbox" / "Unsorted" from `/settings`.

## Fix

In `src/routes/_authenticated.tsx`:

1. Import `useNavigate` and `useRouterState` from `@tanstack/react-router`.
2. In `SidebarInner`, read the current pathname and grab a `navigate` instance.
3. Update the `pick` helper so that when the current route isn't `/`, it navigates to `/` in addition to setting the selection:

   ```ts
   const pick = (s: FolderSelection) => {
     setSelected(s);
     if (pathname !== "/") navigate({ to: "/" });
     onNavigate?.();
   };
   ```

4. Apply the same to the "Inbox" link's `onClick` path implicitly — it's already a `<Link to="/">`, so it's fine.

That's the entire change. No backend, schema, or other UI work.

## Out of scope

- No change to how `selected` is stored or to the Inbox page rendering.
- No URL-based folder selection (e.g. `/folders/$id`) — could be a future improvement but not what was asked.
