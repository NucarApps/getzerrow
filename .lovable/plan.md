## Goal

Remove the standalone "My card" item from the sidebar. Keep the existing "My card" button on the Contacts page as the only entry point for editing your card.

## Current state

- The sidebar (`src/routes/_authenticated.tsx`, ~lines 312–321) has a "My card" nav button that routes to `/my-card`.
- The Contacts page (`src/routes/_authenticated/contacts.index.tsx`, ~line 273) already has a "My card" button linking to `/my-card`.
- The `/my-card` route itself (`src/routes/_authenticated/my-card.tsx`) is the editor for the card.

## Changes

### `src/routes/_authenticated.tsx`
- Delete the "My card" sidebar button block (the `<button>` with the `IdCard` icon that navigates to `/my-card`).
- Remove the now-unused `IdCard` import.

### No other changes
- Keep the `/my-card` route so the Contacts page button still opens the card editor.
- Leave the Contacts page "My card" button as-is.

## Verification
- Typecheck with `tsgo --noEmit`.
- Confirm the sidebar no longer lists "My card", and the "My card" button on the Contacts page still opens the editable card.
