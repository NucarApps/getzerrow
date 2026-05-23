## Goal

When a contact is added with a new company domain we don't have a logo for yet, fetch and show a logo automatically more often. Today the proxy only tries Clearbit then Google favicons; if Clearbit doesn't have the brand and Google's favicon is tiny/generic, the row falls back to the first-letter monogram. That's why only some of the 27 new contacts got a logo.

## Changes

### 1. Expand provider fallback chain in `src/routes/api/public/logo.ts`

Try providers in order, returning the first real image:

1. **Clearbit Logo API** — `https://logo.clearbit.com/{domain}?size=512` (current)
2. **Logo.dev (public, no key)** — `https://img.logo.dev/{domain}?size=512&format=png` (good coverage for SMBs Clearbit misses)
3. **DuckDuckGo icon service** — `https://icons.duckduckgo.com/ip3/{domain}.ico` (works for many small/regional sites)
4. **Direct site `/favicon.ico` and common apple-touch-icon paths** — fetched from the domain itself at a higher resolution (`/apple-touch-icon.png`, `/apple-touch-icon-precomposed.png`, then `/favicon.ico`)
5. **Google s2 favicons** — `https://www.google.com/s2/favicons?domain={domain}&sz=256` (current last-resort)

Keep the `MIN_BYTES = 600` filter so we still reject the generic 1×1/grey-globe responses. Keep the 4s per-provider timeout but cap total work by short-circuiting on first success.

### 2. Cache the resolved logo per domain

Add a tiny in-memory + edge-cache short-circuit on `?domain=` so repeat lookups across the 27 new contacts don't re-walk the chain. We already send `Cache-Control: public, s-maxage=604800, immutable` on hits; mirror that for 404 misses with a shorter TTL (e.g. 1 hour, already partly there) so we don't hammer providers, and bump the success TTL to 30 days.

### 3. Make person-row UI prefer the site-derived domain consistently

`CompanyLogo` already calls `/api/public/logo?domain=...`. Confirm the contact list passes the same `contactLogoDomain(website, email)` it uses for the bucket header so both rows and headers query the same domain (avoiding cases where the header has a logo but the row asks for a different domain and misses).

## Out of scope

- No DB schema changes; no `avatar_url` writeback. Logos stay as a derived/cached view from the proxy.
- No background prefetch job — adding 27 contacts already triggers 27 first-paint requests, which will warm the cache for everyone after this change.

## Validation

- Open the contacts page after this change and confirm the previously blank rows now show real logos.
- Check 2–3 specific domains that failed before (Clearbit-only misses) and confirm the network panel shows `200` from `/api/public/logo?domain=...`.
- Confirm domains with truly no online logo still fall back to the first-letter monogram (no broken images).
