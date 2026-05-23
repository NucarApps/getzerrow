## Problem
`CompanyLogo` already falls back to a monogram when all providers fail, but in practice some providers return a generic placeholder (Google's globe favicon, DuckDuckGo's default) with a 200 + `image/*` content type. The proxy treats those as "found" and the UI never falls through to the first-letter monogram.

## Plan
1. **Tighten the proxy's "real logo" check** in `src/routes/api/public/logo.ts`:
   - Drop DuckDuckGo and direct `/favicon.ico` from `providersFor()` (both routinely return generic globes for unknown domains). Keep Clearbit, then Google as the only fallback.
   - Raise the minimum byte threshold from 80 to ~600 bytes — Google's generic globe is ~500 bytes; real logos are much larger.
   - Return 404 (not an image) when nothing qualifies, so `<img onError>` advances.

2. **Simplify client candidates** in `src/lib/company-domains.ts`:
   - `logoCandidates()` returns only `[ '/api/public/logo?...' ]`. No external fallbacks — if the proxy says no, we want the monogram, not a globe.

3. **Monogram already handled** in `CompanyLogo.tsx` — when the single candidate errors, `idx` exceeds `candidates.length` and the existing monogram block renders the first letter of `name || domain`. No change needed there.

4. **Verify** by reloading `/contacts` and confirming companies without real logos (e.g. obscure domains) show a clean colored initial instead of a globe icon.

### Technical notes
- The monogram already uses `name` first, then `domain`, so "Acme Corp" shows "A".
- Cache headers stay the same so previously-cached globes will refresh within a day; a hard reload shows the fix immediately.

No DB, auth, or routing changes.