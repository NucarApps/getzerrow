# Gmail reconnect banner

When any connected Gmail account's OAuth token has been revoked/expired (`needs_reconnect = true`), show a prominent banner at the top of every logged-in page prompting the user to reconnect. This mirrors the existing "Reconnect Gmail" action already living in Settings → Account health, but surfaces it globally so it's caught quickly (like Shawn Hanlon's inbox that silently stopped syncing for 23h).

## What the user sees

- A red/destructive banner pinned at the top of the app content, directly above the current `BackfillBanner`, on every authenticated page.
- Copy names the affected inbox, e.g. *"Gmail disconnected for shawn@nucar.com — reconnect required to resume syncing."* If more than one account is affected, it summarizes (e.g. *"2 inboxes need reconnecting"*) and lists each with its own reconnect button.
- A **Reconnect** button per affected account that kicks off the Google OAuth flow (same behavior as the Settings button). Clicking redirects to Google consent and returns to Settings on success.
- The banner disappears automatically once the account is reconnected (the reconnect flag clears server-side, and the health query refetches).
- Nothing shows when all accounts are healthy.

## Technical details

- **New component** `src/components/inbox/ReconnectBanner.tsx`:
  - Uses the existing `getAccountHealth` server function (via `useServerFn` + `useQuery`, key `["account-health"]`) which already returns `needsReconnect`, `email`, and `lastOauthError` per account. Reuse the same query key so it shares cache with the Settings health panel; poll on an interval (e.g. 60s) so a newly-broken account surfaces without a manual refresh.
  - Filters to `accounts.filter(a => a.needsReconnect)`; renders nothing if empty.
  - Reconnect button calls `startConnectGmail` (`useServerFn`) with `{ data: { login_hint: email } }` and sets `window.location.href = r.url`, identical to `AccountHealthPanel.handleReconnect`.
  - Styled with existing destructive design tokens (border-destructive/40, bg-destructive/10, text-destructive) and lucide `AlertTriangle` / `RefreshCw` icons — consistent with the current reconnect block in `AccountHealthCard.tsx`. No hardcoded colors.
  - Optional local dismiss state so the user can hide it for the session (still reappears on reload while unresolved). Keep it lightweight.

- **Wire into layout** `src/routes/_authenticated.tsx`:
  - Render `<ReconnectBanner />` immediately above the existing `<BackfillBanner />` (line ~147), so it appears on inbox, contacts, meetings, reports, settings, and admin.

No backend, schema, or server-function changes are required — all needed data and the reconnect action already exist.
