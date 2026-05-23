## Plan

The logo component is wired correctly, but no logo image requests are appearing in the preview, which means the cards are likely not getting usable logo domains in the rendered state. I’ll make the domain source more reliable and remove the image attributes that can block third-party favicon rendering.

### What I’ll change

1. **Add website-based logo domains**
   - Include `website` in the contacts list query.
   - Add a helper that extracts a clean domain from a website URL or raw domain.
   - Prefer `contact.website` for company logos, then fall back to the email domain.

2. **Fix grouped company buckets**
   - Store the best available logo domain on each company bucket.
   - Keep sorting alphabetically by company name.
   - Keep personal email buckets using initials instead of company logos.

3. **Make image loading less fragile**
   - Remove `crossOrigin="anonymous"` from the visible `<img>` so providers like Google favicons are not blocked by CORS behavior.
   - Use a stable `key` on each logo candidate so provider fallback reliably reloads when it advances.
   - Keep the existing provider fallback order and monogram fallback.

4. **Verify**
   - Check the preview/network requests after implementation to confirm favicon/logo URLs are being requested and visible where available.