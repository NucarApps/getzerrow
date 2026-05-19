## Plan

The refresh loop is coming from the login page: whenever an existing Google session is detected, it tries to reconnect Gmail using tokens from the current auth session. Because Google refresh tokens are only returned during consent flows, the app is effectively encouraging repeated Google consent instead of reusing the already stored Gmail refresh token.

### Changes to implement

1. **Stop forcing consent on normal sign-in**
   - Update the login Google OAuth call to avoid `prompt=consent` for regular app login.
   - Keep Gmail scopes, but do not ask Google to show the permissions screen every time.

2. **Do not auto-save Gmail tokens on every login refresh**
   - Remove the login-page auto-connect behavior that depends on `provider_refresh_token`.
   - After successful login/session restore, simply navigate into the app.

3. **Keep explicit Gmail reauthorization separate**
   - Leave the Settings “Reauthorize Gmail” flow as the place that intentionally uses `prompt=consent` and `access_type=offline` to obtain/store a Gmail refresh token.
   - This keeps Gmail access durable without repeatedly asking on page refresh.

4. **Verify auth guard behavior**
   - Check that protected routes still wait for the stored session with `supabase.auth.getUser()`.
   - Confirm the app does not redirect to `/login` after a normal refresh when the session is still valid.

### Expected result

Refreshing the app should keep you signed in. Google should only ask for Gmail access again when you intentionally click **Reauthorize Gmail** or if access was revoked/expired.