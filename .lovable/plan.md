## Add Google sign-in to login

The current `/login` page only supports email/password. Add a "Continue with Google" button as the primary sign-in option, with email/password kept as a secondary fallback.

### Changes

1. **Enable Google as an auth provider** on Lovable Cloud via `configure_social_auth` with `providers: ["google"]`. Uses Lovable's managed Google OAuth — no API keys or Google Cloud setup needed from you.

2. **Update `src/routes/login.tsx`**:
   - Add a prominent "Continue with Google" button at the top of the form, with the Google "G" icon.
   - Wire it to `lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin })` from `@/integrations/lovable`.
   - Add a subtle "or" divider between the Google button and the existing email/password form.
   - Handle the `result.error` / `result.redirected` cases with a toast on failure.

3. **Keep email/password** as-is below the divider so existing accounts still work.

### Notes
- Google is the only social provider — Lovable Cloud doesn't support GitHub/Facebook/etc. natively.
- No DB or schema changes. Existing `onAuthStateChange` listener at the root will pick up the new session and route the user into the app.
