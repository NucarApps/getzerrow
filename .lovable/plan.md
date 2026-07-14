# Fix the CAPTCHA finding without a Supabase dashboard

You're on Lovable Cloud, so auth settings live in the **Backend** panel (the Cloud UI), not a Supabase dashboard. Since the app only uses Google OAuth, we don't need CAPTCHA at all — we just need to close the unused email/password + `/recover` surface the scanner flagged.

## Recommended: disable the Email auth provider

The scanner hit `/auth/v1/recover`. That endpoint only exists because the Email provider is enabled. Disabling it removes the attack surface entirely — no CAPTCHA needed, no code changes.

Steps you do in the app:
1. Open **Backend** (button in the Lovable sidebar / top bar).
2. Go to **Users → Auth Settings → Providers**.
3. Turn **Email** off. Leave **Google** on.
4. Save.

Result: `/signup`, `/token?grant_type=password`, and `/recover` all stop accepting requests. The medium "no CAPTCHA on auth" and "weak rate limit on password reset" findings both go away.

## What I'll do after you confirm it's off

1. Verify Google sign-in still works in preview.
2. Mark the CAPTCHA and password-reset rate-limit findings resolved in `@security-memory` with the rationale "Email provider disabled — only Google OAuth is used."
3. Delete `.lovable/plan.md` (the old Turnstile plan) since it's no longer relevant.

## If you'd rather keep Email enabled

Tell me and I'll instead walk you through enabling Turnstile in **Backend → Users → Auth Settings → Bot & Abuse Protection** (you'd create a Turnstile site at Cloudflare, paste the **Secret key** into that panel — no code changes needed either way, since the app never calls the email/password endpoints).
