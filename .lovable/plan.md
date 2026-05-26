# Fix "Connect another Gmail" so it actually adds a second account

## Problem
From the inbox header → email dropdown → "Connect another Gmail" lands on Settings, but the only button there says "Reconnect Gmail" — which sounds like it'll re-auth the current account, not add a new one. And even when clicked, Google's OAuth screen tends to silently re-auth the already-signed-in account because the request uses `prompt: "consent"` (no account chooser).

## Changes

### 1. `src/routes/_authenticated/settings.tsx` — button label
Line 84: when at least one account is connected, label the top-right button **"Add another Gmail"** (icon stays `Plus`). Keep "Connect Gmail" when none. The per-account "Reconnect" button (line 126, only shown when `needs_reauth`) already covers the re-authorize case.

```tsx
{busy === "connect" ? "Redirecting…" : accounts.length === 0 ? "Connect Gmail" : "Add another Gmail"}
```

Also tighten the helper text on line 80 to match: "Connect multiple Gmail inboxes and switch between them from the inbox header."

### 2. `src/lib/google-oauth.server.ts` — force account chooser
Change the OAuth `prompt` from `"consent"` to `"select_account consent"` so Google always shows the account picker. This guarantees the user can pick a *different* Google account when adding one, and still forces consent (needed for `refresh_token`).

```ts
prompt: "select_account consent",
```

### 3. `src/components/AccountSwitcher.tsx` — direct connect (no settings detour)
Make "Connect another Gmail" start the OAuth flow directly instead of bouncing to Settings:

- Import `useServerFn` + `startConnectGmail`.
- On select: call `startConnectGmail({ data: {} })` and redirect to the returned `url` (same pattern as `startConnect` in settings.tsx).
- Show a brief "Redirecting…" toast on failure, fall back to navigating to `/settings` if the server fn errors.

Keep `goSettings` for "Manage accounts" if we want a secondary entry later — for now just replace the action.

## Out of scope
- No schema changes. `gmail_accounts` already supports multiple rows per `user_id` (uniqueness is `(user_id, email_address)`).
- No change to the OAuth callback — it already upserts a new account when the email differs.
- No new tests; the change is UX copy + a query param.

## Verification
- From the inbox header dropdown → "Connect another Gmail" → Google account picker appears (not auto-consent to current account).
- Pick a different Google account → callback creates a second `gmail_accounts` row → AccountSwitcher shows two emails.
- Settings → top button now says "Add another Gmail" when one is already connected; per-account "Reconnect" still appears for accounts in `needs_reauth`.
