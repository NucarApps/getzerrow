No changes needed — answering your question.

Yes. When you edit or add a contact on iOS:

1. iOS sends a CardDAV `PUT` to Zerrow with the updated vCard.
2. `handlePut` parses it and applies a non-destructive patch: only fields present in the vCard are updated, so partial syncs don't clobber other data.
3. Emails/phones with custom labels (iOS `itemN.EMAIL` grouped properties) are now parsed correctly after last turn's fix — no more `carddav+uuid@local.zerrow` placeholders.
4. A revision is written to `contact_revisions` (20-deep undo) before the change lands.
5. The CTag bumps so other devices pull the update on next refresh.

If something ever looks off, the contact drawer has a revision history you can restore from.