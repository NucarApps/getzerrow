## Goal

Serve the Apple App Site Association (AASA) file at
`https://getzerrow.com/.well-known/apple-app-site-association` with:
- HTTP `200`
- `Content-Type: application/json`
- the exact JSON body you provided

so your iOS app can verify domain ownership (Associated Domains: webcredentials + applinks).

## Why a server route instead of a static `public/` file

The request asked for `public/.well-known/apple-app-site-association`. On this project's
Cloudflare Workers deployment, an **extensionless** static file is not reliably served with
`Content-Type: application/json` — it typically comes back as `application/octet-stream`, or the
request falls through to the app's SPA/404 handler. Apple's fetcher rejects anything that isn't
JSON with a 200. The project already handles this exact situation for `sitemap.xml` by using a
**server route** (`src/routes/sitemap[.]xml.ts`) that sets the content-type explicitly. We'll do
the same for AASA, which guarantees the status and content-type you need.

## Change

Create one new server route file:

- `src/routes/[.]well-known.apple-app-site-association.ts`

  - The `[.]` escapes the leading dot and dots-become-slashes maps the filename to the URL
    `/.well-known/apple-app-site-association`.
  - `createFileRoute("/.well-known/apple-app-site-association")` with a `GET` handler.
  - Returns the exact JSON body below, with `Content-Type: application/json` and a
    `Cache-Control` header. AASA has no path components to match, so `applinks.details[].components`
    stays `[]` as provided.

Exact body served:

```json
{
  "webcredentials": {
    "apps": ["78TF75BED3.app.rork.vgbwcg1s46vqobhajrjd5"]
  },
  "applinks": {
    "apps": [],
    "details": [
      {
        "appIDs": ["78TF75BED3.app.rork.vgbwcg1s46vqobhajrjd5"],
        "components": []
      }
    ]
  }
}
```

The auto-generated `src/routeTree.gen.ts` will pick up the new route on build/dev — it is not
edited by hand.

## Notes

- The global `securityHeaders()` wrapper in `src/server.ts` will add its standard headers to the
  response; none of them prevent Apple from reading the JSON (the CSP does not apply to a raw JSON
  fetch), so no changes there are needed.
- No auth is involved — the route is public and returns no user data, so it doesn't need to live
  under `/api/public/*`.

## Verification

After building, confirm:
- `GET /.well-known/apple-app-site-association` → `200`
- response header `content-type: application/json`
- body byte-for-byte matches the JSON above

This can be checked against the preview/published URL with a simple request, and by inspecting the
served headers.
