## Goal

Ship an iOS companion app for Zerrow, built with Rork AI (Expo/React Native), that signs in with the same Google account and reads/writes the same Lovable Cloud database as the web app — with push notifications for mail that needs attention.

## How the integration works

- **Reads (inbox, folders, contacts, meetings, cards, reports):** the mobile app queries your Lovable Cloud database directly with the Supabase JS client. Your existing Row-Level Security already scopes every table to the signed-in user, so no new read APIs are needed.
- **Auth:** Supabase Google OAuth via a mobile deep link (`zerrow://auth-callback`). Same users, same accounts as the web app.
- **Actions that trigger Gmail/AI logic (archive, mark read, move to folder, edit card, meeting settings):** the web app runs these through TanStack server functions that the mobile app can't reach. I'll add a small set of authenticated mobile endpoints on this project so the app can perform them safely (bearer-token verified, RLS enforced).
- **Push:** the app registers an Expo push token; I'll store it and send a push when new important mail is filed.

```text
 iOS app (Rork/Expo)
   ├── Supabase JS  ─── reads/simple writes ──▶ Lovable Cloud DB (RLS)
   ├── /api/mobile/* ── Gmail/AI actions ─────▶ this project's server
   └── expo-notifications ◀── push ─────────── this project's push sender
```

## Part A — Backend work I'll do in this Lovable project

1. **Mobile auth redirect:** add `zerrow://auth-callback` to the allowed OAuth redirect URLs so Google sign-in returns to the app.
2. **Push tokens table:** `device_push_tokens` (user_id, expo_token, platform, timestamps) with RLS scoped to `auth.uid()` and GRANTs.
3. **Push sender:** a server route that sends Expo push notifications, wired into the existing new-mail/folder-filing path so users get notified about mail needing attention.
4. **Mobile action endpoints** (authenticated, bearer-verified, reusing existing sync/gmail/card/meeting logic) for: archive, mark read/unread, move to folder, edit My Card, and update meeting settings — giving the app write parity without duplicating business logic.

## Part B — The Rork prompt (copy this into Rork)

```text
Build a polished iOS app in Expo (React Native + TypeScript) called "Zerrow" — a mobile companion to an existing email-triage web app. It connects to an existing Supabase backend; do not create a new backend. Use @supabase/supabase-js with these env vars (I'll paste values): EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY.

AUTH
- Sign in with Google via supabase.auth.signInWithOAuth({ provider: 'google' }) using expo-web-browser + a deep link redirect "zerrow://auth-callback". Persist the session with AsyncStorage. Show a clean login screen; gate the app behind an authenticated session.

DATA (all tables are RLS-scoped to the current user; just query them)
- emails: filed mail (subject, from, snippet, folder_id, is_read, received_at, etc.)
- folders + folder_filters: user's folders/buckets
- contacts, contact_phones, contact_groups, contact_group_members: CRM
- my_cards: the user's shareable contact card
- meetings, meeting_participants, meeting_bot_settings: meetings + recordings + settings
- gmail_accounts: connected mail accounts (read-only display)

SCREENS (bottom tab nav: Inbox, Contacts, Meetings, More)
1. Inbox: list of folders with unread counts; tapping a folder shows its emails. Pull-to-refresh. Supabase realtime subscription on the "emails" table for live updates. Swipe actions on an email: Archive, Mark read/unread.
2. Email detail: full sender/subject/body, and actions Archive, Mark read/unread, Move to folder (folder picker).
3. Contacts: searchable list; contact detail with phones, company, groups.
4. My Card: view + edit the user's card fields (name, title, company, links) and save.
5. Meetings: upcoming + past meetings, recording playback link, and a settings screen (bot/auto-record toggles).
6. More: Reports (simple counts/analytics from the data), connected accounts (read-only), sign out.

ACTIONS THAT NEED THE SERVER (do NOT write these directly to the DB)
- Archive, mark read/unread, move to folder, edit My Card, update meeting settings must call authenticated HTTPS endpoints on the web backend (I'll provide base URL + paths under /api/mobile/*). Send the Supabase access token as "Authorization: Bearer <token>". Show optimistic UI with rollback on error.

PUSH NOTIFICATIONS
- Use expo-notifications. On login, request permission, get the Expo push token, and upsert it to a "device_push_tokens" table (columns: user_id, expo_token, platform). Handle notification taps to deep-link into the relevant email/folder.

DESIGN
- Clean, modern, minimal. Light background, a single warm orange accent for primary actions, rounded cards, generous spacing, SF-style system font. Sentence case for all headings and buttons. Friendly, professional copy — no lorem ipsum.

Use React Query for server state, a service layer for all Supabase/API calls (no fetch directly in components), named exports, and strict TypeScript (no any).
```

## Part C — Step-by-step for you

1. **Approve this plan** so I add the backend pieces (redirect URL, push table, push sender, mobile endpoints). I'll give you the exact base URL and `/api/mobile/*` paths + a short API note to paste into Rork.
2. **Grab your two values** from this project's `.env`: `VITE_SUPABASE_URL` → use as `EXPO_PUBLIC_SUPABASE_URL`, and `VITE_SUPABASE_PUBLISHABLE_KEY` → use as `EXPO_PUBLIC_SUPABASE_ANON_KEY` (these are publishable, safe in the mobile app).
3. **Open Rork**, start a new project, paste the Part B prompt, then paste the two env values and the API note when it asks.
4. **Test** in Rork's preview / Expo Go: sign in with Google, confirm your real folders/emails/contacts load.
5. **Build & ship:** use EAS Build (`eas build -p ios`) and submit to TestFlight, then the App Store (needs an Apple Developer account, $99/yr).

## Notes / trade-offs

- Full parity is achievable but the Gmail/AI-side actions must go through the new mobile endpoints — the app should not write those state changes straight to the DB, or it would skip your sync/side-effect logic.
- Google sign-in on mobile needs the `zerrow://auth-callback` redirect allow-listed (Part A step 1); without it sign-in will bounce.
- Push requires an Apple Developer account and a real device/TestFlight build (push doesn't fire in the simulator).
