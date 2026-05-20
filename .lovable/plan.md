## Bug

`cannot add postgres_changes callbacks for realtime:sidebar-rt after subscribe()`

## Cause

The mobile responsive refactor renders `SidebarInner` twice — once in the desktop `<aside>` and once inside the mobile `<Sheet>` drawer. Both instances call `supabase.channel("sidebar-rt").on(...).subscribe()` with the same channel name. Supabase reuses the channel by name, so the second mount tries to attach a `postgres_changes` listener after the first instance already called `.subscribe()` → throws.

## Fix

In `src/routes/_authenticated.tsx`, lift the realtime subscription out of `SidebarInner` and into the parent `AuthedLayout` component, so it runs exactly once regardless of how many sidebar copies are mounted. The subscription only invalidates React Query keys, which both sidebar instances already read from — no prop drilling needed.

Remove the `useEffect` + channel setup from `SidebarInner` and place an equivalent `useEffect` in `AuthedLayout` (it still needs `useQueryClient`).

No other behavior changes.
