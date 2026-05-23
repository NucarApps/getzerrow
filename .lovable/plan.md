## Goal

When the user turns on **By company** on the Contacts page:
1. Every company section should start **collapsed** by default (currently they all start expanded).
2. Each company section header should be **tinted with the company's brand color**, extracted from its logo, with the logo shown on the left as today.

Domain → logo wiring already exists (`logo.dev` via `CompanyLogo`). This plan adds dominant‑color extraction and re‑themes the section headers.

## UX

- Toggle **By company** on → all buckets collapse. The list becomes a tidy stack of colored company chips.
- Each header shows:
  - Company **logo** (32px, as today) on the left.
  - Background tinted to the logo's dominant color (soft, ~12–15% opacity) with a 1px border using the same color at ~35% opacity.
  - Company name + `domain · N contacts` (today's copy).
  - Chevron on the right; click to expand.
- Click any header to expand just that company; collapse state otherwise persists for the session.
- **Personal email** and **Other** buckets keep the neutral card style (no domain → no logo color).
- Flat (non‑grouped) view is unchanged.

Edge cases:
- Logo fails to load → fall back to today's monogram + neutral `bg-card/40` (no tint).
- Color extraction fails or returns near‑white/near‑black → fall back to neutral.
- Dark mode: the tint uses `color-mix(... in oklab, transparent)` so it stays subtle on both themes.

## Technical changes

1. **`src/lib/logo-color.ts`** (new, ~60 lines, client‑only):
   - `getLogoDominantColor(domain): Promise<string | null>` returning an `oklch(...)` or hex string.
   - Implementation: load `logoUrl(domain, 64)` into an `Image` with `crossOrigin = "anonymous"`, draw to a 32×32 offscreen `<canvas>`, sample pixels, ignore near‑transparent / near‑white / near‑black pixels, pick the most saturated bucket (simple hue histogram, 12 bins). Cache results in a module‑level `Map<domain, string>` plus `sessionStorage` so we only compute once per domain per session.
   - Returns `null` on CORS error or all‑neutral logos so callers can fall back.

2. **`src/components/contacts/CompanyLogo.tsx`**:
   - Add optional `onColor?: (color: string | null) => void` prop. After the `<img>` successfully loads, call `getLogoDominantColor(domain)` once and forward the result. No visual change to the logo itself.

3. **`src/components/contacts/CompanyBucketHeader.tsx`** (new, small):
   - Encapsulates the header button. Owns a local `color` state, passes `onColor` into `<CompanyLogo>`, and applies inline styles:
     ```ts
     style={ color ? {
       backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)`,
       borderColor:     `color-mix(in oklab, ${color} 35%, transparent)`,
     } : undefined }
     ```
   - Renders title, subtitle, chevron, collapsed prop — same markup as today's inline header.

4. **`src/routes/_authenticated/contacts.index.tsx`**:
   - Change collapse default: when `groupByCompany` flips on, seed `collapsed` with every bucket key (`useEffect` watching `groupByCompany` + `companyBuckets`). When it flips off, leave the set alone (cheap).
     - Concretely: on transition `false → true`, `setCollapsed(new Set(companyBuckets.map(b => b.key)))`.
   - Replace the inline header `<button>` inside the `groupByCompany` branch with `<CompanyBucketHeader …/>` so each section can tint itself independently.
   - Move the `border border-border` from the `<section>` wrapper to the header (so the colored border replaces the neutral one) and keep `bg-card/40` only on the expanded body.

5. **No DB / no server / no new dependencies.** Color extraction uses the browser canvas API; `logo.dev` already serves images with permissive CORS for unauthenticated requests.

## Out of scope

- Persisting collapsed state across page reloads.
- Letting users override the inferred company color.
- Tinting the flat list rows (kept neutral — only the grouped headers get color).

## Open question

Want the expanded body to also pick up a faint version of the brand color (e.g. a 4% wash behind the contact rows), or keep the body neutral so the colored header pops? Default plan keeps the body neutral.
