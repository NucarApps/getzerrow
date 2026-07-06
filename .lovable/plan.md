# Native Swift OAuth: `zerrow://auth-callback`

Goal: let the Swift app sign in with Supabase (Google) and get sent back into the app via the deep link `zerrow://auth-callback`, then document the full native auth setup.

## Part A — Backend redirect allow-list (honest status)

For Supabase to redirect to `zerrow://auth-callback` after OAuth, that exact URL must be in the auth **redirect URI allow-list**. Today it contains only web URLs:

```text
https://getzerrow.com/**
https://www.getzerrow.com/**
https://getzerrow.lovable.app/**
+ preview URLs
```

**Limitation:** the tools I have (auth toggles, social providers, MCP OAuth server) do **not** expose editing this general redirect allow-list. So I cannot add `zerrow://auth-callback` to it directly from here. Two ways forward — I recommend Option 2:

- **Option 1 — keep the redirect flow.** The value `zerrow://auth-callback` must be added to the redirect allow-list through backend auth settings. I'll flag this as the exact required value; adding a custom URL scheme to the list needs to happen at the Cloud/auth-config level outside my current tooling.
- **Option 2 (recommended) — native ID-token flow, no allow-list change.** Use the Google Sign-In SDK on-device to get a Google ID token, then call `supabase.auth.signInWithIdToken`. This needs **no** custom scheme in the redirect allow-list, is the standard robust native pattern, and avoids the Option 1 blocker entirely. The deep-link scheme is then only used by the Google SDK callback, which is configured in the Google client, not Supabase.

I'll write the guide to cover **both** so you can pick, with Option 2 as the primary path.

## Part B — Swift setup guide (new doc)

Create `docs/swift-auth.md` with a complete, copy-pasteable setup:

1. **Connection values**
   - Project URL: `https://axilcinlnaujxyksfjin.supabase.co`
   - Anon/publishable key (already provided earlier)

2. **Info.plist** — register the URL scheme `zerrow` (so `zerrow://auth-callback` opens the app), and add the Google reversed-client-id scheme for the SDK flow.

3. **Package** — add `supabase-swift` (and `GoogleSignIn-iOS` for Option 2) via SPM.

4. **Option 2 flow (recommended)** — GoogleSignIn requesting Gmail scopes with offline access → obtain `idToken` + `serverAuthCode` → `supabase.auth.signInWithIdToken(provider: .google, idToken:)` → session stored by supabase-swift.

5. **Option 1 flow (redirect)** — `supabase.auth.signInWithOAuth(provider: .google, redirectTo: URL("zerrow://auth-callback"), scopes: "openid email profile gmail.modify gmail.readonly gmail.send", queryParams: [("access_type","offline")])` handled via `ASWebAuthenticationSession`, then `supabase.auth.session(from: url)` on the deep-link callback. Requires the Part A allow-list entry.

6. **Session handling** — read `supabase.auth.currentSession`, observe `authStateChanges`, and how RLS applies automatically to `/api/mobile/*` calls with the bearer token (matches `src/lib/mobile-auth.server.ts`).

7. **Gmail connect note (important for Zerrow to actually work)** — the web app sends the Google `provider_token` + `provider_refresh_token` to a server fn (`connectGmailFromSession`) so the backend can sync Gmail. The Swift app must do the equivalent: forward the Google refresh token / server auth code to a mobile endpoint. There is **no** `/api/mobile/gmail-connect` route yet — I'll document the exact payload the Swift app should POST and flag that this endpoint needs to be built (separate task) for Gmail sync to work on mobile.

## Technical details

- Scopes must match the web login (`src/routes/login.tsx`): `openid email profile` + `gmail.modify gmail.readonly gmail.send`, with `access_type=offline` to get a refresh token.
- Mobile API auth already expects `Authorization: Bearer <access_token>` and validates via `getClaims` (`src/lib/mobile-auth.server.ts`), so once signed in, the Swift app calls the existing `/api/mobile/*` routes directly.
- No web-app code changes are required for sign-in itself; the only web-side follow-up is a future `/api/mobile/gmail-connect` route for Gmail token handoff.

## Deliverables

- `docs/swift-auth.md` (both flows, Info.plist, packages, session handling, Gmail-connect payload spec).
- Clear statement of the exact redirect value `zerrow://auth-callback` and that adding it to the redirect allow-list is a backend-config step outside current tooling (Option 1), with Option 2 as the no-config-needed alternative.
