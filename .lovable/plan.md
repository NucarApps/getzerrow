## Goals
1. On desktop `/contacts`, hide the email folder side panel — that column is only useful for Inbox/mail views.
2. Rebalance the contacts page so the middle contact list is narrower and the right-hand detail pane is larger.

Note on the "rocket ship logo in the top left": the current top-left is the small `Z` app button in the icon rail. I'm not changing it in this plan — let me know if you actually want it swapped for the rocket-ship artwork.

## Changes

### `src/routes/_authenticated.tsx` — hide Folders panel outside Inbox
- In `DesktopRails`, keep the 56px icon rail always visible.
- Render the `w-56` folder panel (Views / Folders / Sync status block, ~lines 585–680) only when `pathname === "/inbox"` (or starts with `/inbox`). On `/contacts`, `/meetings`, `/reports`, `/tasks`, `/settings`, `/admin` it collapses away entirely, giving the page full width.
- Keep `AddFolderDialog` / `EditFolderDialog` mounts inside the panel (only needed when it's visible).
- Mobile `SidebarInner` unchanged.

### `src/routes/_authenticated/contacts.index.tsx` — rebalance columns
- Narrow the middle list: cap the contact list column so it doesn't stretch across the whole freed-up width. Wrap the list container (line ~1115 `<div className="min-w-0 flex-1 overflow-y-auto">`) with `max-w-[720px]` on `xl:` and up so on large screens it renders at a readable width instead of consuming everything.
- Widen the right detail aside (line 1398): change `w-[clamp(300px,30vw,400px)]` to `w-[clamp(420px,42vw,640px)]` so the loading/detail area gets significantly more room.
- Groups panel (`w-56`, line 830) stays as-is.

No changes to data, routing, or business logic.
