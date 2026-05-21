## What's happening

In `src/routes/_authenticated.tsx`, every folder row calls:

```ts
const pick = (s) => {
  setSelected(s);                                  // React state in context
  if (pathname !== "/inbox") navigate({ to: "/inbox" }); // route change
  onNavigate?.();                                  // setMobileOpen(false) → Sheet starts unmounting
};
```

Three state changes are queued in the same tick, and the Radix `Sheet` (the mobile drawer) begins its close transition immediately. On touch devices that produces two failure modes that match what you're seeing ("drawer closes and inbox goes blank / wrong"):

1. **Selection lost on cross-route taps.** `FolderSelectionProvider` is mounted inside `_authenticated` with `useState("all")` as the initial value (`src/lib/folder-selection.tsx`). When you tap a folder from a non-`/inbox` authed page, the navigation to `/inbox` happens in the same tick as `setSelected`. Depending on the order React commits, the new `selected` can be written into a provider snapshot that's about to be replaced, so `/inbox` mounts with the default `"all"` selection — the inbox renders the wrong folder.
2. **Stale email pane on same-route taps.** Already on `/inbox`, `pick()` doesn't navigate; it just changes `selected` and closes the sheet. `inbox.tsx` resets `selectedId` inside a `useEffect([selectedFolder])` (line 149–153), which runs *after* the first render with the new folder. For one frame the previously-opened email is still in `selectedId`, and the master/detail toggle at line 327 (`${selected ? "hidden md:flex" : "flex"}`) hides the list on mobile — so the user sees a blank/wrong panel until the effect fires.

## Fix

Two small, surgical changes — no redesign, no behavioral change on desktop.

### 1. Persist folder selection across remounts

In `src/lib/folder-selection.tsx`, back `selected` with `localStorage` so a context remount (or a cross-route tap that re-mounts `_authenticated`) preserves the user's choice:

```ts
const STORAGE_KEY = "zerrow.selectedFolder";
const [selected, setSelectedState] = useState<FolderSelection>(() => {
  if (typeof window === "undefined") return "all";
  return (localStorage.getItem(STORAGE_KEY) as FolderSelection) || "all";
});
const setSelected = (v: FolderSelection) => {
  setSelectedState(v);
  try { localStorage.setItem(STORAGE_KEY, v); } catch {}
};
```

This makes the cross-route tap reliable: `setSelected` writes synchronously to storage, and the freshly-mounted provider on `/inbox` reads it back.

### 2. Reset the open-email synchronously when the folder changes

In `src/routes/_authenticated/inbox.tsx`, drop the dependency on the `useEffect` for clearing the open email. Replace the existing pattern that derives `selectedId` from `useState` with one that derives it from `selectedFolder` so it can never lag a render:

- Track `selectedId` keyed off `selectedFolder` via a ref, or — simpler — clear `selectedId` inline in the `pick` path. The cleanest version: change `useState<string | null>(null)` to a small reducer that returns `null` whenever it sees a new `selectedFolder`, OR keep the state but render the list/reader split using a derived `selected` that is forced to `null` when `selectedListItem` is `null` (already true on line 295 — but the mobile toggle on line 327 uses `selected`, which is correct; the only edit needed is to make sure `selected` reflects "no match in current folder" on the first render).

Concretely: change line 327's condition from `selected ?` to `selected && selectedListItem ?`, so the mobile list is shown immediately whenever the new folder doesn't contain the previously-open email.

### 3. Defer the drawer close past the navigation commit

In `src/routes/_authenticated.tsx`, change `pick` so the sheet closes *after* the route navigation has been queued, not in the same tick:

```ts
const pick = (s: FolderSelection) => {
  setSelected(s);
  if (pathname !== "/inbox") navigate({ to: "/inbox" });
  queueMicrotask(() => onNavigate?.());
};
```

This is the same defensive ordering we used for Settings/Inbox tap handlers — it costs nothing and removes a class of touch-vs-Dialog races.

## Files touched

- `src/lib/folder-selection.tsx` — add localStorage persistence (~6 lines).
- `src/routes/_authenticated.tsx` — `pick()` uses `queueMicrotask` for `onNavigate` (~1 line).
- `src/routes/_authenticated/inbox.tsx` — tighten the mobile master/detail condition on line 327 (~1 line).

No styling changes. No changes to desktop, server functions, RLS, or routing. No new dependencies.

## Verification

1. On mobile, from `/index` (landing) → log in → land on `/inbox`, open drawer, tap **All mail** → drawer closes, list shows All mail.
2. On mobile, on `/inbox` open an email, then open drawer and tap a different folder → drawer closes, that folder's list shows (no stuck Reader, no blank panel).
3. On mobile, on `/settings`, open drawer, tap a custom folder → navigates to `/inbox` AND shows that folder's emails (not "All inbox").
4. Reload the page → the last selected folder is restored.
5. On desktop, all of the above still works identically.

## Out of scope

- No redesign of `FolderRow` or the drawer.
- No change to the folder edit pencil affordance.
- No URL-based folder selection (could be a future improvement — encode `?folder=<id>` in `/inbox` — but not needed to fix this bug).
