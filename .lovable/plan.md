# Plan: Add Cloudflare Turnstile to auth forms

Addresses medium-severity finding: no CAPTCHA on Supabase auth endpoints. Turnstile is free, invisible/managed, and fits the Cloudflare stack.

## What you'll need to do (one-time, in dashboards)

1. **Create a Turnstile site** at Cloudflare dashboard → Turnstile → Add site.
   - Domains: `getzerrow.com`, `www.getzerrow.com`, `getzerrow.lovable.app`, `localhost`.
   - Widget mode: **Managed** (recommended — invisible when possible).
   - Copy the **Site key** (public) and **Secret key** (private).
2. **Enable CAPTCHA in Backend → Auth settings**: set provider = Turnstile, paste the **Secret key**, save. This makes Supabase Auth require and verify a Turnstile token on sign-in / sign-up / recover.
3. Provide the **Site key** to me via `VITE_TURNSTILE_SITE_KEY` (public, safe in codebase — I'll add it to `.env` and `.env.example`).

## What I'll build

1. Install `@marsidev/react-turnstile`.
2. Add `VITE_TURNSTILE_SITE_KEY` to `.env.example` (and `.env` with the value you give me).
3. Create `src/components/auth/TurnstileWidget.tsx` — thin wrapper that renders the widget in managed mode, forwards the token via `onSuccess`, and exposes a reset handle for use after failed submits.
4. Update the auth form(s) — locate the current sign-in / sign-up / forgot-password components (likely under `src/routes/auth*` or `src/components/auth/`) and:
   - Render `<TurnstileWidget>` above the submit button.
   - Track `captchaToken` in local state; disable submit until present.
   - Pass `options: { captchaToken }` to `supabase.auth.signInWithPassword`, `signUp`, and `resetPasswordForEmail`.
   - On error, reset the widget so the user gets a fresh token.
5. Leave Google OAuth (`lovable.auth.signInWithOAuth`) untouched — Turnstile only guards email/password + recover.
6. Verify: build passes, both forms render the widget locally, and a submit without a token is blocked.

## Follow-up on other findings

- **Low — COOP/CORP header**: already shipped in previous turn (`src/server.ts`). Marking that finding as fixed.
- **Medium — weak rate limit on password reset**: this Turnstile rollout is the intended defense (a token is required per request). Once shipped, mark that finding as fixed too and note the rationale in `@security-memory`.

## Out of scope

- Changing Supabase's built-in auth rate-limit dials (not accessible on Lovable Cloud).
- Adding Turnstile to non-auth forms (contact card, etc.) — can be a follow-up.
