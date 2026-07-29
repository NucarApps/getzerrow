## Goal

When you filter a message into a folder from the inbox, also choose whether mail matching that rule gets marked read automatically — and have that choice persist in the folder's "Auto mark-read" settings, so the folder editor and the drawer always agree.

## Behavior

After you pick a target folder in the drawer, a new "Mark as read" control appears with two options:

- Mark matching mail as read
- Leave it unread

The control starts on whatever the folder would do today for this sender, so leaving it alone changes nothing. It is hidden when the target is "Keep in inbox" (inbox overrides have no folder settings), and hidden when the rule matches on subject only (folder mark-read scope is sender/domain based).

Saving applies the rule as it does now, plus the mark-read choice, using the folder's existing scope model (Everything / Everything except… / Only these senders…):

| Folder today | You chose "mark read" | You chose "leave unread" |
| --- | --- | --- |
| Auto mark-read off | Turn it on, switch to "Only these senders", add this sender/domain | No change |
| Everything | No change | Switch to "Everything except", add this sender/domain |
| Everything except | Remove this sender/domain from the exception list | Add this sender/domain |
| Only these senders | Add this sender/domain | Remove this sender/domain |

A short line under the control explains the effect in plain words, e.g. "Mail from kenect.com in Reports will be marked read automatically." A separate toast confirms the folder setting change so it is never silent.

## Technical details

- New server functions in `src/lib/gmail/mark-read-rules.functions.ts`:
  - `getFolderMarkReadDecision({ folder_id, value })` — returns `{ auto_mark_read, mark_read_mode, would_mark_read }`, reusing `resolveAutoMarkRead` from `src/lib/sync/mark-read-scope.ts` so the drawer's preview and the sync pipeline can't diverge.
  - `setSenderMarkRead({ folder_id, value, mark_read })` — applies the transition table above in one owned-folder-scoped write (folder update plus rule insert/delete), then calls `invalidateAccountContext` like the existing rule mutations.
- `FilterLikeThisDrawer.tsx`: fetch the decision when `folderId` and the sender value are set; render the two-option control (same `FieldTab` styling as the existing tabs); call `setSenderMarkRead` after the rule save succeeds, only when the choice differs from the current decision. Invalidate `["folder-mark-read-rules"]` and `["folders"]` so the folder editor picks it up.
- The value written is the same normalized sender/domain the rule uses, including the origin-sender variant when "Original sender" is selected, so forwarded mail is scoped by the real sender.
- Tests: extend `src/lib/sync/mark-read-scope.test.ts` with a pure `nextMarkReadScope(current, choice)` helper covering all eight transitions, and keep the server function as a thin wrapper around it.
