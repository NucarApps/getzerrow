## Plan

Replace the current DuckDuckGo-only logo loading with a more reliable multi-provider fallback so company cards show real logos whenever possible.

### What I’ll change

1. **Generate multiple logo candidates per domain**
   - Try Google favicon first: `https://www.google.com/s2/favicons?domain=...&sz=...`
   - Then DuckDuckGo icon: `https://icons.duckduckgo.com/ip3/...`
   - Then Clearbit logo as a final public fallback: `https://logo.clearbit.com/...`

2. **Update `CompanyLogo` to fail over provider-by-provider**
   - If one image fails or returns a blank/unusable icon, automatically try the next URL.
   - Only show the monogram after all candidates fail.
   - Reset retry state when the domain changes.

3. **Make color extraction use the same reliable source list**
   - Try candidate logo URLs in order until one loads and can be sampled.
   - Keep the card tint behavior, but don’t let color extraction failure prevent the logo from displaying.

4. **Verify the result**
   - Confirm sample domains like `mtb.com`, `presidio.com`, `withsift.ai`, and `littler.com` produce a visible logo or gracefully fall back only when no provider has one.