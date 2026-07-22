## What's happening

The `X` + `getzerrow.com` bar and bottom share/refresh/compass toolbar in your screenshot are iOS Safari's own browser chrome — not Zerrow UI. Your Home Screen icon is opening the site in a regular Safari tab because the project has no web app manifest and no `apple-mobile-web-app-capable` meta tag. That means iOS shows browser chrome on every page. Why it seems to "go away" on Inbox: Safari auto-collapses the toolbar when the page scrolls the window; Inbox happens to hit that; Contacts (sticky header + inner scroll container starting at top) doesn't, so the chrome stays fully expanded.

The correct fix is to make Zerrow install as a full-screen home-screen app so there is no Safari chrome at all — on Contacts or anywhere else.

## Plan (manifest-only PWA — no service worker, no offline)

1. **Add `public/manifest.webmanifest`** with:
   - `name: "Zerrow"`, `short_name: "Zerrow"`
   - `start_url: "/inbox"`, `scope: "/"`, `id: "/"`
   - `display: "standalone"`, `orientation: "portrait"`
   - `background_color: "#0a0e1a"`, `theme_color: "#0a0e1a"` (matches app background)
   - Icon entries pointing at existing `public/` icons (reuse current favicon/apple-touch icons; no new art).

2. **Extend `src/routes/__root.tsx` head()** with:
   - `<link rel="manifest" href="/manifest.webmanifest">`
   - `<meta name="theme-color" content="#0a0e1a">`
   - `<meta name="apple-mobile-web-app-capable" content="yes">`
   - `<meta name="mobile-web-app-capable" content="yes">`
   - `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`
   - `<meta name="apple-mobile-web-app-title" content="Zerrow">`
   - Update viewport to `width=device-width, initial-scale=1, viewport-fit=cover` so the app draws under the notch cleanly in standalone mode.

3. **No service worker, no `vite-plugin-pwa`, no offline caching** — those aren't needed for hiding the Safari chrome and add risk to previews.

## What you'll need to do on your phone

iOS caches Home Screen manifest fields at install time. To pick up the change:
- Delete the current Zerrow icon from your Home Screen
- Reopen `getzerrow.com` in Safari → Share → **Add to Home Screen**
- Launch from the new icon — it will open full-screen with no URL bar, no bottom toolbar, on Contacts and every other page

Users who already added an icon will keep seeing browser chrome until they re-add it once; new visitors get the standalone experience on first install.

## Non-goals

- Not adding offline mode, service workers, push notifications, or install prompts.
- Not changing the Contacts scroll layout — the standalone launch removes the chrome entirely, so the Inbox/Contacts scroll difference stops mattering.
