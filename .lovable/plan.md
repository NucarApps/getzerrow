## Plan

Strip the login page down to Google-only and disable email/password at the auth provider so nobody can sneak in via the API.

### Changes

1. **`src/routes/login.tsx`** — remove the email/password form, the signup/signin mode toggle, the divider, and all related state. Keep just the heading and the "Continue with Google" button (with its existing error handling and `onAuthStateChange` redirect).

2. **Disable the email provider** via `supabase--configure_social_auth` with `providers: ["google"]` and `disable_providers: ["email"]`. This turns off password sign-in/signup at the backend so the route can't be abused.

3. **Leave intact**: `_authenticated` layout, sign-out, and the password-reset route if any (none in the current tree, so nothing to delete).

No DB or RLS changes. No new routes.