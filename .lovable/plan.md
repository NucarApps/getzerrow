## Diagnosis

`https://img.logo.dev/{domain}` returns **HTTP 404** without a publishable API token (`?token=pk_…`). That's why no company logos appear — every `<img>` errors out and falls back to the monogram. The dominant‑color extraction also never runs (no image to sample).

## Fix

Switch to a **keyless** icon source: **DuckDuckGo's icon service**, which is free, requires no signup, and supports CORS:

```
https://icons.duckduckgo.com/ip3/{domain}.ico
```

It returns a real favicon (often a clean square logo) for almost every domain, and a generic placeholder otherwise. Verified working (HTTP 200) in tests.

### Change

- **`src/lib/company-domains.ts`** — rewrite `logoUrl(domain)`:
  ```ts
  export function logoUrl(domain: string, _size = 64): string {
    return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
  }
  ```
  (`size` arg kept for signature compatibility; DDG ignores it.)

- **`src/components/contacts/CompanyLogo.tsx`** — no change needed; the existing `onError` → monogram fallback still handles the rare miss.

- **`src/lib/logo-color.ts`** — no logic change. DDG serves with `Access-Control-Allow-Origin: *`, so the canvas read for dominant‑color extraction still works.

### Why not logo.dev with a token

Adding `logo.dev` properly would require the user to sign up at logo.dev, get a publishable key (safe to ship client‑side), and we'd wire it as a `VITE_LOGO_DEV_TOKEN` env var. Higher‑quality logos but adds friction. Happy to do that as a follow‑up if you want sharper brand marks — DDG is the zero‑setup fix.

## Out of scope

- A per‑domain manual logo override.
- Pre‑fetching/caching logos server‑side.
