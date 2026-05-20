## Right-click context menu on email list rows

Add a right-click context menu to each email row in the inbox/folder list with these actions:

1. **Move to folder →** submenu of all folders + "Inbox (no folder)"
2. **Always send sender to inbox** — adds `from_addr` to `inbox_overrides` (match_type=email)
3. **Always send domain to inbox** — adds the domain of `from_addr` to `inbox_overrides` (match_type=domain)
4. Separator + quick **Archive** / **Trash** (nice-to-haves, optional)

### Implementation

**`src/lib/gmail.functions.ts`** — add one new server function:
- `addInboxOverride({ value, match_type })` — upserts a row in `inbox_overrides` for the current user. (Today `moveEmailToInbox` already accepts an `add_override` flag, but it also moves the email; we want override-only when the email is already in inbox or the user just wants to whitelist without moving.)

**`src/routes/_authenticated/index.tsx`**:
- Wrap each list row `<button>` in `<ContextMenu>` from `@/components/ui/context-menu` (already installed).
- Build the menu inline per-row with:
  - `ContextMenuSub` "Move to folder" listing `folders` + Inbox option, calling existing `moveEmailToFolder` / `moveEmailToInbox` with optimistic cache updates (mirroring the Reader's move logic — extract into a small `useEmailActions(email)` helper to avoid duplication).
  - Two items: "Always send {sender} to inbox" and "Always send @{domain} to inbox" calling the new `addInboxOverride` fn, then toast.
  - Archive / Trash items reusing existing `archiveEmail` / `trashEmail`.
- Domain is derived client-side from `from_addr.split("@")[1]`; hide the domain item if no `@`.
- Right-clicking does NOT select the email (preserve `setSelectedId` only on left click).

### Out of scope
- No DB schema changes (table + RLS already exist).
- No changes to the existing Reader action bar, MoveSimilarDialog, AlwaysInboxDialog, or settings InboxOverrides UI.
- No training/folder_examples additions.
