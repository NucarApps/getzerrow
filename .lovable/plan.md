## Goal

Right-click on an email → besides "Always send to inbox", also offer **"Always send to folder ▸"** with a submenu of every folder, each offering **Future only** or **Future and past**. Picking one writes a sender/domain rule onto that folder so all future matching mail auto-routes there, and optionally moves matching past mail too.

## How it maps to what's already built

- **Folder filter rules** already exist (`folder_filters` rows with `field: from|domain`). The matcher in `sync.server.ts` already honors them on new mail.
- **`bulkMoveEmails`** server fn already accepts `create_rule: { field: "from"|"domain", value }` and writes a `folder_filter` while moving — so "Future and past" is a thin wrapper around it.
- **`MoveSimilarDialog`** already lets the user preview matching past mail before moving. We'll reuse it for the "Future and past" path.

So this is mostly UI wiring plus one small server fn for the "Future only" path.

## UX

In `src/routes/_authenticated/inbox.tsx` context menu, after the existing "Always send to inbox" block:

```
Always send to folder
  Just ceo@chevrolet.com      ▸   Future only
                                  Future and past
  Anyone @chevrolet.com       ▸   Future only
                                  Future and past
```

Each sender/domain branch opens a second submenu listing every folder; choosing one runs the action. Picked folder is highlighted if the email is already in it (disabled).

- **Future only** → call new `addFolderRule` server fn → toast "Future mail from X will go to *Folder*".
- **Future and past** → open `MoveSimilarDialog` preconfigured with `toFolder`, `mode: sender|domain`, `create_rule` enabled by default → user confirms the preview list → existing `bulkMoveEmails` does the move + rule write in one shot.

Duplicate-rule guard: if a `folder_filters` row already exists for (folder, field, value), toast "Already routed to *Folder*" instead of inserting again.

## Server changes

1. **New server fn `addFolderRule`** in `src/lib/gmail.functions.ts`:
   - Input: `{ folder_id: string, field: "from"|"domain", value: string }`
   - Auth-guarded; verifies the folder belongs to `userId`.
   - Lowercases `value`, dedupes against existing `folder_filters` row.
   - Inserts `{ folder_id, field, op: "contains", value }` (matches existing rule shape used by `bulkMoveEmails`).
   - Returns `{ already: boolean }`.

2. No schema migration needed — `folder_filters` already supports this.

3. `bulkMoveEmails` and `findSimilarEmails` are reused as-is for the "Future and past" path.

## UI changes

- `inbox.tsx` context menu: add new `Always send to folder` section after the existing inbox-override section, with the nested submenu structure above. Folder list comes from the existing `folderList` already in scope.
- `MoveSimilarDialog`: add optional prop `defaultCreateRule?: "sender" | "domain" | null` so the dialog opens with the correct chip preselected for this flow. (Currently the chip is always "sender" on open.)
- Reuse `addFolderRuleFn = useServerFn(addFolderRule)` alongside the existing `addOverrideFn`.

## Edge cases

- Folder list empty → submenu shows "No folders yet" disabled item.
- Sender address missing → hide the "Just <email>" branch (same pattern as inbox-override section).
- If the email is already in folder X, still allow adding the rule (user may want to lock it in), but show "(current folder)" hint.
- "Future and past" path uses the existing `MoveSimilarDialog` 50-match limit and confirmation, so accidental bulk-moves stay safe.

## Files touched

- `src/lib/gmail.functions.ts` — add `addFolderRule` server fn.
- `src/routes/_authenticated/inbox.tsx` — extend context menu + wire dialog.
- `src/components/emails/MoveSimilarDialog.tsx` — accept `defaultCreateRule` prop.

No DB migration.
