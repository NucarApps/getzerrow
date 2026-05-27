## "Filter messages like this" drawer

Collapse the current nested **Always send to folder → Just sender → folder → Future/past** menu into a single right-click item that opens a focused drawer. This makes the subject-line option a first-class citizen alongside sender and domain, and removes 3 levels of menu nesting.

### UX

Right-click an email → new top-level item:

- **🪄 Filter messages like this…**

Clicking opens a right-side drawer (reuse the `Sheet` pattern already used in `ContactDrawer`) with the following sections, top to bottom:

1. **Match by** — segmented control with three tabs:
   - `Sender` — pre-filled with `e.from_addr`
   - `Domain` — pre-filled with the `@domain` portion
   - `Subject` — pre-filled with `e.subject`
2. **Value** — editable text input bound to the selected tab. The user can tweak the address, the domain, or the subject text.
3. **Match type** — only shown for Subject:
   - *Starts with* (default)
   - *Contains*
   - *Exact match*
   
   Sender and Domain stay as today (`contains`-style equality on the parsed field).
4. **Send to folder** — list of the user's folders (color dot + name), single-select. Current folder disabled.
5. **Apply to** — radio:
   - *Future emails only* (default)
   - *Future and past matching emails*
6. **Live preview** — a small "About N existing emails match" line that runs a lightweight count query as the user edits (debounced 250ms). Lets the user catch over-broad subject filters before saving.
7. Footer: **Cancel** / **Create filter**.

On **Create filter**:
- Call `addFolderRule` with `{ folder_id, field, op, value }`.
- If "Future and past" is checked, also reuse `MoveSimilarDialog`'s retro-apply logic — but inline (no second dialog hop): after the rule insert, fire the same reassign-and-batch-modify call the dialog uses today, then toast the result.
- Close the drawer and invalidate `["folder-filters"]` + `["emails"]`.

### Right-click menu cleanup

Remove from the email row context menu:
- The entire `Always send to folder` submenu (the `from_addr` sub, the `domain` sub, all their nested folder pickers, all `Future emails only` / `Future and past` items).

Keep:
- `Always send to inbox` (sender / domain) — different feature (overrides), separate flow.
- All other items (mark read/unread, archive, snooze, move to folder, etc.).

Add the new single item right where the old `Always send to folder` block was so muscle memory carries over.

### Backend

`src/lib/gmail.functions.ts` → `addFolderRule`:
- Extend `field` enum to `"from" | "domain" | "subject"`.
- Add optional `op: "contains" | "equals" | "starts_with"` (default `contains` for from/domain to preserve current behavior; required for subject).
- Don't strip a leading `@` when field is `subject` (only when field is `domain`).
- Include `op` in the dedupe lookup so the same value with two different match types can coexist.

New server function `countMatchingEmails({ account_id, field, op, value })` (or extend existing) that returns a count for the live-preview line. Caps at 500 for speed.

The filter engine already supports `subject` with `contains` / `equals` / `starts_with`, so no engine changes.

### Components

- New: `src/components/emails/FilterLikeThisDrawer.tsx` — owns all drawer state, calls `addFolderRule` and the retro-apply path.
- Edit: `src/routes/_authenticated/inbox.tsx` — drop the nested submenus, add the new menu item + drawer trigger state.
- Edit: `src/components/emails/MoveSimilarDialog.tsx` — extract its retro-apply logic into a reusable function (or export an `applyFolderRuleToPast` helper) so the drawer can call it without opening a second dialog.

### Out of scope

- No DB migration (free-form text columns already in place).
- No changes to AI classification, sync pipeline, or realtime.
- The mobile/touch right-click path keeps working — drawer is responsive by default.

### Open question

Should the drawer also let the user add **multiple conditions** (e.g. subject *starts with* "Invoice" AND domain = `stripe.com`) in one step, or keep it strictly single-condition for now? My recommendation: ship single-condition first to match today's mental model, and add an "Add condition" button later if you ask for it.
