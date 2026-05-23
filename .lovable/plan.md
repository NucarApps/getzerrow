## Plan

1. **Stop using an iframe on mobile email bodies**
   - Add a lightweight mobile-only email body renderer that sanitizes the HTML and renders it directly inside the reader scroll area.
   - Keep the existing iframe renderer for desktop, where sizing and isolation are less likely to hit the mobile iframe lifecycle bug.

2. **Make email body rendering deterministic when backing out and reopening**
   - Tie the mobile body container key to the email id and body content so each open is a fresh render.
   - Remove the fragile mobile dependency on iframe `srcDoc`, `load`, and `postMessage` timing that can alternate between loaded and blank.

3. **Preserve readable email styling**
   - Apply scoped email-body CSS for common HTML email elements: images, tables, links, text wrapping, and light background/text.
   - Strip unsafe tags/attributes before injecting HTML.

4. **Verify the exact flow**
   - On a mobile-sized viewport, open an email, tap Back, open the same email repeatedly, and confirm it no longer alternates between content and a white page.
   - Confirm desktop still uses the iframe reader and continues to render normally.

## Technical notes

- Primary file: `src/routes/_authenticated/inbox.tsx`.
- No backend, sync, or Gmail fetching changes.
- This targets the observed pattern: the same email alternates loaded/blank only after mobile back/open, which points to iframe remount/load timing rather than missing data.