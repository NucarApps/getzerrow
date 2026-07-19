# Zerrow Swift app — Supabase auth (Google) setup

This guide covers signing the native Swift app into the Zerrow backend with
Google, using the deep link `zerrow://auth-callback`. Two flows are documented:

- **Option 2 (recommended)** — native Google ID-token flow. No change to the
  backend redirect allow-list is required.
- **Option 1** — web-based redirect flow. Requires `zerrow://auth-callback` to
  be added to the backend auth redirect allow-list (see "Backend redirect
  allow-list" below).

---

## Connection values

```
SUPABASE_URL       = https://axilcinlnaujxyksfjin.supabase.co
SUPABASE_ANON_KEY  = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4aWxjaW5sbmF1anh5a3NmamluIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMDUwMDYsImV4cCI6MjA5NDc4MTAwNn0.G_LCsns9WKBptWkWdjDzDx7jzcXGBK0R8Pa_ESs7sZ4
```

Both are public client values, safe to embed in the app binary. Row-level
security protects all data — the anon key alone cannot read another user's rows.

---

## 1. Swift Package Manager dependencies

Add via **File → Add Package Dependencies…**:

- `https://github.com/supabase/supabase-swift` — the Supabase client.
- `https://github.com/google/GoogleSignIn-iOS` — only needed for Option 2.

---

## 2. Info.plist — URL schemes

Register the app's custom scheme so `zerrow://auth-callback` reopens the app,
and (for Option 2) the Google reversed-client-id scheme.

```xml
<key>CFBundleURLTypes</key>
<array>
  <!-- Zerrow deep link: zerrow://auth-callback -->
  <dict>
    <key>CFBundleURLName</key>
    <string>com.zerrow.app</string>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>zerrow</string>
    </array>
  </dict>
  <!-- Google Sign-In (Option 2). Value is your REVERSED_CLIENT_ID
       from GoogleService-Info.plist, e.g. com.googleusercontent.apps.1234-abcd -->
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>com.googleusercontent.apps.YOUR_REVERSED_CLIENT_ID</string>
    </array>
  </dict>
</array>
```

---

## 3. Create the Supabase client

```swift
import Supabase

let supabase = SupabaseClient(
  supabaseURL: URL(string: "https://axilcinlnaujxyksfjin.supabase.co")!,
  supabaseKey: "PASTE_ANON_KEY_HERE"
)
```

supabase-swift persists the session in the Keychain and refreshes it
automatically, so you generally only sign in once.

---

## Option 2 (recommended) — native Google ID-token flow

No redirect allow-list change needed. The user stays inside a native Google
sheet, and Supabase accepts the resulting ID token directly.

### Scopes

Zerrow syncs Gmail server-side, so request the same scopes the web app uses and
ask for offline access to obtain a refresh token:

```
openid
email
profile
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
```

### Sign-in

```swift
import GoogleSignIn
import Supabase

func signInWithGoogle(presenting: UIViewController) async throws {
  let gmailScopes = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ]

  // Presents the native Google sheet. `additionalScopes` adds Gmail on top of
  // the default openid/email/profile.
  let result = try await GIDSignIn.sharedInstance.signIn(
    withPresenting: presenting,
    hint: nil,
    additionalScopes: gmailScopes
  )

  guard let idToken = result.user.idToken?.tokenString else {
    throw AuthError.missingIDToken
  }
  let accessToken = result.user.accessToken.tokenString

  // Exchange the Google ID token for a Supabase session.
  try await supabase.auth.signInWithIdToken(
    credentials: .init(provider: .google, idToken: idToken, accessToken: accessToken)
  )

  // For Gmail sync you also need a refresh token / server auth code — see
  // "Gmail connect handoff" below. Configure a serverClientID so Google
  // returns a serverAuthCode you can forward to the backend.
}
```

> Configure `GIDSignIn` with your `clientID` (from `GoogleService-Info.plist`)
> and set `serverClientID` to the Google **Web** client ID so
> `result.serverAuthCode` is populated — that's what the backend exchanges for a
> Gmail refresh token.

---

## Option 1 — web redirect flow (via the `/auth-callback` bridge)

A custom URL scheme (`zerrow://`) cannot be added to the backend auth redirect
allow-list, so **do not** point Supabase OAuth directly at `zerrow://auth-callback`.
Instead, point it at the allow-listed HTTPS bridge page
`https://getzerrow.com/auth-callback`. That page immediately forwards the OAuth
result (tokens or `?code=`) to `zerrow://auth-callback`, and supabase-swift's
`session(from:)` finishes the session. No allow-list change is needed.

Uses `ASWebAuthenticationSession`:

```swift
import Supabase

func signInWithGoogleRedirect() async throws {
  try await supabase.auth.signInWithOAuth(
    provider: .google,
    redirectTo: URL(string: "https://getzerrow.com/auth-callback")!,
    scopes: "openid email profile https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    queryParams: [
      ("access_type", "offline"),
      ("prompt", "consent"), // ensures a refresh token is returned
    ]
  )
  // supabase-swift opens ASWebAuthenticationSession. Google redirects to the
  // HTTPS bridge, which forwards to zerrow://auth-callback to complete sign-in.
}
```

> Set `ASWebAuthenticationSession`'s `callbackURLScheme` to `zerrow` so the
> session captures the redirect to `zerrow://auth-callback`. supabase-swift does
> this for you when you pass a `zerrow://` `redirectTo`, but here the browser is
> sent to the HTTPS bridge first; the bridge then bounces to `zerrow://`.

Handle the deep link (SwiftUI):

```swift
.onOpenURL { url in
  Task {
    do {
      try await supabase.auth.session(from: url)
    } catch {
      // surface a sign-in error
    }
  }
}
```

---

## 4. Session handling

```swift
// Current session (nil if signed out)
let session = try? await supabase.auth.session
let accessToken = session?.accessToken

// Observe auth state changes
Task {
  for await (event, session) in supabase.auth.authStateChanges {
    switch event {
    case .signedIn, .tokenRefreshed:
      // update UI, cache access token
      break
    case .signedOut:
      // return to sign-in screen
      break
    default:
      break
    }
  }
}

// Sign out
try await supabase.auth.signOut()
```

---

## 5. Calling the mobile API

Once signed in, call the existing `/api/mobile/*` endpoints with the Supabase
access token as a bearer. The backend validates the token and applies RLS as the
signed-in user (see `src/lib/mobile-auth.server.ts`).

```swift
var request = URLRequest(url: URL(string: "https://getzerrow.com/api/mobile/card")!)
request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
let (data, _) = try await URLSession.shared.data(for: request)
```

Available today: `/api/mobile/card`, `/api/mobile/emails.action`,
`/api/mobile/meeting-settings`, `/api/mobile/push-test`.

---

## 6. Gmail connect handoff (required for sync to work)

Signing in authenticates the user, but Zerrow only syncs an inbox once the
backend holds a Gmail **refresh token** for that account. On the web, the login
page forwards `provider_token` + `provider_refresh_token` to a server function
(`connectGmailFromSession`) which stores the encrypted tokens and starts the
Gmail push watch.

The Swift app must do the equivalent. There is **no `/api/mobile/gmail-connect`
route yet** — it needs to be built as a follow-up. Expected request shape:

```
POST https://getzerrow.com/api/mobile/gmail-connect
Authorization: Bearer <supabase access token>
Content-Type: application/json

{
  "email_address": "user@gmail.com",
  // Option 1: forward the Google refresh token obtained from the OAuth flow
  "refresh_token": "<google refresh token>",
  "access_token": "<google access token>",
  "expires_in": 3600
  // Option 2 alternative: send "server_auth_code" and let the backend exchange
  // it server-side for a refresh token.
}
```

Until that endpoint exists, mobile sign-in works for reading already-synced data
via the mobile API, but connecting a new Gmail account must still be done from
the web app.

---

## Backend redirect allow-list (not required)

A custom URL scheme (`zerrow://auth-callback`) **cannot** be added to the auth
redirect allow-list. That's why Option 1 redirects to the HTTPS bridge page
`https://getzerrow.com/auth-callback` instead — it's already covered by the
existing allow-list entry `https://getzerrow.com/**`, and it forwards the OAuth
result on to `zerrow://auth-callback` client-side.

```
https://getzerrow.com/**        ← covers the /auth-callback bridge
https://www.getzerrow.com/**
https://getzerrow.lovable.app/**
(+ preview URLs)
```

So no allow-list change is needed for either option. Option 2 stays the
recommended path because it keeps the whole flow inside a native Google sheet.
