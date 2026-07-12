## Plan

1. **Fix the empty account state shown in the screenshot**
   - Make the inbox page use the same fallback account logic as the sidebar/account switcher.
   - If the saved active account is missing or stale, automatically select the first connected Gmail account and reset to **All inbox**.
   - Ensure the mobile header does not show “Connect a Gmail account” when connected accounts exist but the inbox page has not hydrated the active account yet.

2. **Make the Bill/William emails visible in All inbox**
   - Re-check the two `WGamgort@ycst.com` emails in the database.
   - If they are already tagged with Gmail `INBOX` and not archived, keep them in Zerrow’s All inbox.
   - If local metadata drifted, repair only those rows so their local Zerrow state matches Gmail.

3. **Add a guard against this happening again**
   - Tighten the inbox account/folder selection logic so a stale local selection cannot make the inbox query run with no account and return an empty list.
   - Keep the existing account-scoped folder guard so switching accounts cannot land on another account’s folder.

4. **Verify**
   - Confirm the backend returns the two Bill emails for the active account’s All inbox.
   - Verify the inbox UI no longer shows the “Connect a Gmail account” empty state for a connected user.
   - Confirm searching for Bill/William/Gamgort finds the same two messages if they are still in Gmail’s inbox.

## Technical notes

- Primary files likely involved: `src/routes/_authenticated/inbox.tsx`, `src/routes/_authenticated.tsx`, and possibly a targeted data repair via backend migration if the two rows are locally stale.
- No new broad Gmail OAuth changes are needed; this is a Zerrow inbox visibility/account-selection issue, not the previous Google client-secret problem.