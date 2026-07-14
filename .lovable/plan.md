## Security report — proposed fixes

Three findings (0 critical, 0 high, 2 medium, 1 low). Here's how I'd address each:

### 1. Low — Missing `Cross-Origin-Resource-Policy` header ✅ straightforward
Add `Cross-Origin-Resource-Policy: same-origin` to the `securityHeaders()` block in `src/server.ts` (same place that already sets CSP, HSTS, XFO, etc.). Applies to every response via the existing `withSecurityHeaders` wrapper. No app behavior change — the app doesn't serve resources cross-origin (logos are proxied through `/api/public/logo`).

### 2. Medium — Weak rate limiting on Supabase password reset ⚠️ out of scope for code
The scanner hit Supabase's built-in password-reset endpoint (`/auth/v1/recover`) and observed 30 requests before throttling. On Lovable Cloud we don't control Supabase's auth rate-limit dials — there's no dashboard access. The realistic mitigations are:
- Enable CAPTCHA on the auth forms (finding #3 below) — Supabase then requires a token per request, which is the intended defense for this exact CWE.
- Otherwise: accept the finding. I'll note it in `@security-memory` if you want.

I do **not** recommend building an app-layer rate limiter in front of Supabase auth — the scanner is testing Supabase directly, not our routes, so it wouldn't change the result.

### 3. Medium — No CAPTCHA on auth forms ❌ needs your decisions before I build
This is a real, meaningful fix but it's not a one-liner and needs choices from you:

- **Provider**: Cloudflare Turnstile (free, fits the CF stack, invisible/managed challenge) or hCaptcha. I'd recommend Turnstile.
- **Site key + secret**: you'd need to create the site in the provider dashboard, then paste the site key (public, goes in `.env` as `VITE_TURNSTILE_SITE_KEY`) and configure the secret in Supabase Auth → Settings → CAPTCHA. On Lovable Cloud the Supabase-side toggle is done via the Backend view.
- **Where to gate**: `/auth` (email sign-in + sign-up) and the password-reset form. Google OAuth via the Lovable broker is unaffected.
- **Package**: `@marsidev/react-turnstile` (or `@hcaptcha/react-hcaptcha`).

If you want this fix, I'd:
1. Add `VITE_TURNSTILE_SITE_KEY` to `.env.example` and wire it through.
2. Install `@marsidev/react-turnstile`.
3. Render `<Turnstile>` on the email sign-in, sign-up, and reset-password forms in `src/routes/login.tsx` / `auth-callback.tsx` / wherever the reset form lives; pass the token via `options: { captchaToken }` to `supabase.auth.signInWithPassword`, `signUp`, and `resetPasswordForEmail`.
4. Ask you to enable CAPTCHA + paste the provider secret in the Supabase Auth settings (Backend view) — I can't do that step.

### What I'll do now if you approve
- Ship fix #1 (CORP header) immediately.
- For #3, confirm: **Turnstile or hCaptcha?** And are you OK creating the provider site + adding the secret in the Backend view? Once you confirm I'll implement all frontend wiring in one pass.
- For #2, leave as-is unless you want it recorded in security memory.

### Files touched
- `src/server.ts` — one new header line.
- (Pending your call) `src/routes/login.tsx` + any reset-password surface, `.env.example`, `package.json`.
