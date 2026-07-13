## Goal

Replace the plain text-table card emails with a polished, branded "card" layout that mirrors the public card page (`/c/$handle`) — so what lands in someone's inbox looks like a real digital business card instead of a bare list.

## What it looks like today

`src/lib/cards.server.ts` builds two emails (`sendCardEmail`, `sendContactShareEmail`) as a small `<table>` of grey labels + values and a black button. No header, no avatar, no branding — this is the screenshot.

## New design (email-safe HTML)

A centered ~440px card, built with nested `<table>` layout and fully inline styles (required for Gmail/Outlook/Apple Mail — no external CSS, no fl,ex/grid):

```text
┌────────────────────────────────┐
│   ▓▓ colored gradient header ▓▓ │   ← theme color band
│           ( ●  avatar )         │   ← photo, or initials circle
├────────────────────────────────┤
│        Chris Dagesse            │   ← name (large)
│        CEO · Nucar              │   ← title · company
│        "tagline in italics"     │   ← if present
│                                 │
│   ✉  chris@nucar.com            │   ← icon rows (emoji glyphs)
│   ☎  781-514-7000               │
│   🌐 www.nucar.com              │
│                                 │
│   [   View / save my card   ]   │   ← prominent themed CTA button
│                                 │
│   A .vcf is attached — open on  │
│   your phone to add me.         │
│   ── Sent with Zerrow ──        │   ← subtle footer
└────────────────────────────────┘
```

Details:
- **Header band**: solid theme color (with a CSS gradient layered on top for clients that support it; solid `bgcolor` fallback for Outlook). Colors come from a small hex map keyed off the card's `theme` field.
- **Avatar**: uses `avatar_url` when set (`my_cards.select("*")` already returns it — I'll extend the `CardData` type to include `avatar_url`, `cover_url`, `theme`); otherwise an initials circle in the theme color.
- **Contact rows**: name, title·company, phone, email (mailto link), website, LinkedIn, Twitter, address — each with a leading emoji glyph (✉ ☎ 🌐 🔗 📍) so it reads as a card, not a spreadsheet. Rows only render when the field exists (same conditional pattern as now).
- **CTA button**: bulletproof table-cell button (VML-free, rounded, theme accent color) linking to the public card URL.
- **Footer**: quiet "Sent with Zerrow" line.
- **Plain-text part** stays as-is (fallback for text-only clients).

## Scope

- Rewrite the `htmlBody` in both `sendCardEmail` and `sendContactShareEmail`, sharing a helper (e.g. `renderCardEmailHtml`) so both stay consistent.
- Extend the `CardData` type with optional `avatar_url` / `cover_url` / `theme`; the share path passes what it has (no avatar → initials).
- Add a `THEME_EMAIL_COLORS` hex map mirroring `CARD_THEMES` (Tailwind classes can't be used in email).
- No changes to MIME assembly, the .vcf attachment, subjects, or send logic.

## Technical notes

- All styling inline; layout via `<table role="presentation">`; no `<style>` blocks, fl,ex, or grid.
- Widths in px with `max-width`; images with explicit `width`/`alt`; `border:0` on links.
- Header gradient via inline `background-image` with a solid `background-color`/`bgcolor` fallback so Outlook still shows the band.
- Emoji glyphs (not SVG/icon fonts) so the "icons" render everywhere without remote images.

## Verify

Render both templates to a static `.html` file in the sandbox and open a screenshot to confirm layout, then typecheck. (No DB or MIME changes to test beyond that.)
