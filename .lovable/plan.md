## Goal

Simplify both "Always send to inbox" submenus (sender + domain) to just two options:

- Future emails only
- Future and past emails

Remove the third "Remove folder label from past emails (keep archived)" item. The "Future and past emails" handler already does exactly that — adds the override AND strips the folder label without re-inboxing — so no behavior change is needed for the kept option.

## Changes — `src/routes/_authenticated/inbox.tsx`

Delete the third `ContextMenuItem` ("Remove folder label from past emails (keep archived)") in both submenus:

- The `Just {from_addr}` submenu — remove the trailing strip-only item.
- The `Anyone @{domain}` submenu — remove the trailing strip-only item.

No backend change. The `stripFolderLabelPast` server fn stays as-is (still used by the "Future and past emails" handler).

## What stays the same

- Top-level **Move to Inbox** action.
- **Future emails only** — adds override, no past cleanup.
- **Future and past emails** — adds override + strips folder label from past matches (keeps archived state).
