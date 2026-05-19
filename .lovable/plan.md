## What's going on

The "Continue with Google" button calls `lovable.auth.signInWithOAuth("google", ...)`. That flow uses Lovable Cloud's **managed** Google OAuth client by default (Google's branding, not yours). If nothing happens on click, it's almost certainly silently erroring on the broker call — but more importantly, even when it works, the consent screen shows Lovable's Google app, **not yours**.

You already have your own GCP project (set up earlier for Gmail). The fix is to point Lovable Cloud's Google auth at that same OAuth client, so app sign-in and Gmail both run under your GCP.

## Plan

### 1. Reuse your existing GCP OAuth client for app sign-in

In your GCP OAuth 2.0 Web client (the one you created for the Gmail flow), add one extra **Authorized redirect URI**:

```text
https://axilcinlnaujxyksfjin.supabase.co/auth/v1/callback
```

Keep the existing Gmail callback (`https://<your-domain>/api/public/google-oauth-callback`) — both can coexist on the same client.

Also make sure these scopes are added to the **OAuth consent screen**:
- `openid`
- `.../auth/userinfo.email`
- `.../auth/userinfo.profile`

(They're additive to your existing Gmail scopes.)

### 2. Paste the Client ID + Secret into Lovable Cloud → Google provider

Cloud → Users → Auth Settings → Sign In Methods → Google → enter your GCP Client ID + Secret and save. This switches the app sign-in from Lovable's managed Google client to yours.

I'll surface a button in chat that opens that settings panel directly.

### 3. Diagnose the "nothing happens" click

Once your own credentials are in, I'll also:
- Add proper error logging around `lovable.auth.signInWithOAuth` (today the silent path is `result.redirected === false` with no error — we'll surface that)
- Wire a loading state that resets if no redirect happens within ~3s
- Confirm Google is actually enabled in `configure_social_auth` (call it with `providers: ["google"]` to be safe)

### 4. (Optional) Match accounts between app sign-in and Gmail

When you sign into the app with your-name@gmail.com **and** later connect that same Gmail account via the Gmail OAuth flow, both will share the same `user_id`. No code change needed — just worth confirming after the fact.

### Why we're NOT replacing app sign-in with the Gmail OAuth callback

It's tempting to "reuse" `/api/public/google-oauth-callback` for sign-in too, but that route only stores Gmail tokens — it doesn't mint a Supabase session. Doing it that way means hand-rolling JWTs and losing all of Lovable Cloud's session/RLS plumbing. Routing app sign-in through Lovable Cloud with **your** GCP credentials gets you the same end state ("my GCP, my consent screen") without rebuilding auth.

### Technical notes

- `src/routes/login.tsx` — keep `lovable.auth.signInWithOAuth("google", …)`, just improve error handling.
- Call `supabase--configure_social_auth` with `providers: ["google"]` to ensure the provider is enabled.
- The Supabase callback URL (`…supabase.co/auth/v1/callback`) is fixed — that's where Google returns to before Lovable Cloud hands the session back to your app at `window.location.origin`.

## What I need from you before implementing

1. Confirm you're OK pasting your GCP Client ID/Secret into Cloud's Google provider panel (one-time, takes ~30 seconds — I'll open it for you).
2. Add the Supabase redirect URI above to your GCP OAuth client.

Once that's done, I'll harden the login code and we can test.