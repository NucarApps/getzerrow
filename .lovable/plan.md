## Problem
Logos render but look blurry because we request small favicons (~80px) and upscale them. Google's favicon API caps quality; Clearbit returns much sharper logos at 128–256px.

## Plan
1. **Request larger images** — In `CompanyLogo`, fetch at `size * 4` (min 128px) so the rendered 40px image has retina-quality pixels.
2. **Prefer Clearbit for quality** — Update the `/api/public/logo` proxy to try Clearbit first (high-res brand logos), then fall back to Google/DuckDuckGo/direct favicon. Reject tiny images (<200 bytes) so we don't lock in a blurry default.
3. **Add a min-size hint** — Pass `size` through to the proxy and request Clearbit with `?size=256` (it supports a size param) so even small contacts get crisp art.
4. **Verify** — Reload contacts in the browser and confirm M&T, Presidio, Axalta logos render crisply.

No DB or UX changes.