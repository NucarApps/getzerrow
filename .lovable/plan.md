## Goal

Remove the standalone "Always send to inbox" submenu from the inbox right-click menu and fold its behavior into the existing "Filter messages like this…" drawer, so there is one unified filter flow.

## UX

Right-click on a message will show a single rule entry: **Filter messages like this…**. The "Always send to inbox" sub-section (and its `Just sender@…` / `Anyone @domain` submenus, future-only / future-and-past items) is removed.

Inside the drawer, the **Send to folder** list gets a new pinned entry at the top:

```
📥  Inbox — always show       [keep in inbox, skip filters]
────────────────────────────
●  Folder A
●  Folder B
…
```

Picking it switches the drawer into "inbox override" mode:

- Match type is forced to a sender or domain rule (subject tab disabled, op forced to "equals" for sender / "equals" for domain — same semantics as today's overrides).
- The match-type radio block (starts_with/contains/equals) is hidden.
- The live match count keeps working (it already counts past matches against the chosen field/op/value).
- **Apply to** options become:
  - Future emails only → just creates the override.
  - Future and past matches → creates the override AND calls `stripInboxLabelForOverride` (the existing past-cleanup server fn) so past matching messages re-appear in the inbox.
  - "Also archive them" checkbox is hidden in inbox mode (doesn't apply).
- Primary button label becomes **Add to inbox list** (vs. **Create filter** for folders).

Picking any normal folder keeps today's exact behavior.

## Implementation

### `src/components/emails/FilterLikeThisDrawer.tsx`

- Add a sentinel folder id constant `INBOX_OVERRIDE = "__inbox__"`.
- Render an extra row at the top of the folder list using the inbox icon and that sentinel id (disabled when `field === "subject"` and there's no sender/domain to fall back to).
- When `folderId === INBOX_OVERRIDE`:
  - If current `field` is `subject`, auto-switch to `from` (or `domain` if no sender), and disable the Subject tab.
  - Force `op` to `equals` and hide the match-type radios.
  - In `handleSave`, instead of `addFolderRule` + `applyFilterRuleToPast`, call the existing override server fns:
    - `addInboxOverride({ value, match_type: field === "domain" ? "domain" : "email" })`
    - If `applyToPast`, call `stripInboxLabelForOverride({ value, match_type })` (same fns the context menu uses today).
  - Toast copy mirrors today's override flow.
- Hide the "Also archive them" checkbox in inbox mode.
- Swap the save button label based on mode.

### `src/routes/_authenticated/inbox.tsx`

- Delete the `Always send to inbox` block (lines ~985–1080): the label, both `ContextMenuSub` entries (sender + domain), and the related toast/optimistic update handlers.
- Drop now-unused imports/handlers if they're not referenced elsewhere in the file (`addOverrideFn`, `stripLabelFn`, `AtSign`, `Globe` icons used only by this menu). Keep them if other UI still uses them.
- Keep the "Filter messages like this…" item, and keep the existing `AlwaysInboxDialog` mount intact (the bulk-list flow on the sender-grouped view at line 1422 still uses it — out of scope).

### Server / data

No schema or server-function changes. We reuse:
- `addInboxOverride` (already account-scoped after the recent change)
- `stripInboxLabelForOverride`
- `addFolderRule` + `applyFilterRuleToPast` (unchanged)

## Out of scope

- The sender-grouped view's "Always inbox" entry point (separate flow, still uses `AlwaysInboxDialog`).
- Settings → Inbox filters page (unchanged; still the place to review/remove overrides).
