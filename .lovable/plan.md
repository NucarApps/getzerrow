## Problem
The UI is still rendering monogram letters because the app is not reliably loading logo images. In the browser session I also saw the contacts page stuck in a skeleton/loading state, which means logo requests may never be mounted in some sessions.

## Plan
1. **Add a same-origin logo endpoint**
   - Create `/api/public/logo` as a TanStack server route.
   - Validate a `domain` query parameter.
   - Server-side fetch a small ordered list of favicon/logo providers.
   - Return the first successful image with image headers and cache it.
   - This avoids browser-side third-party image/CORS/referrer/ad-block fragility.

2. **Point `CompanyLogo` at the proxy**
   - Change `logoCandidates()` to use `/api/public/logo?domain=...&size=...` as the first visible image source.
   - Keep a simple external fallback only if the proxy fails.
   - Preserve the current letter fallback for companies with no available icon.

3. **Fix loading/error visibility on contacts**
   - Update the contacts page to stop showing endless skeleton rows when the contact query is idle/erroring.
   - Show a clear empty/error state instead, so we can distinguish “contacts didn’t load” from “logos didn’t load.”

4. **Verify**
   - Use the browser network panel to confirm `/api/public/logo` requests are made.
   - Confirm at least common domains like `mtb.com`, `presidio.com`, and `spglobal.com` render image icons when a provider has one.

## Technical notes
- No database changes are needed.
- This keeps the existing contact grouping and monogram fallback behavior.
- The endpoint will only fetch public image URLs and will reject invalid domains to avoid unsafe proxy behavior.