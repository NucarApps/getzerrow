# Zerrow — Technical Features PDF

A branded, in-depth technical reference PDF documenting every feature area of Zerrow: what it does, how it works under the hood, and the key data/pipeline concepts. Audience: internal / technical team.

## Deliverable

A single multi-page PDF written to `/mnt/documents/zerrow-features.pdf` (with a `<presentation-artifact>` preview), plus QA render images verified before delivery.

## Approach

1. **Inventory features from source** (read-only) to keep the doc accurate — sync pipeline, folders/filters, AI classification, inbox overrides, contacts/cards, meetings, reports, folder chat, Gmail integration, security/encryption.
2. **Generate the PDF programmatically** (Python + reportlab) with a branded Zerrow layout, cover page, table of contents, and per-feature sections.
3. **QA pass**: render every page to images, inspect for overflow/overlap/clipping, fix, re-verify.

## Branding

- Pull Zerrow's real brand cues from the codebase (`src/styles.css` tokens, `public/zerrow-landing.css`, logo/assets) so colors and type match the app.
- Cover page with logo/wordmark, document title, "Internal Technical Reference", date.
- Consistent header/footer (Zerrow • Features Reference • page numbers), section dividers, and a restrained accent color from the brand palette.

## Document structure

```text
1. Cover
2. Table of contents
3. Product overview & architecture
   - Stack (TanStack Start / Cloudflare Workers / Lovable Cloud)
   - High-level data flow diagram (Gmail push -> pipeline -> folders -> UI)
4. Gmail integration & sync pipeline
   - OAuth (encrypted tokens), push/Pub-Sub, poll + reconcile fallbacks
   - message_jobs queue, claim RPCs, DLQ, backfill, watch renewal
5. Folders & deterministic filters
   - Filter tree (AND/OR field/op/value), domain_in / not_contains
   - Side-effects: auto_archive, auto_mark_read, hide_from_inbox, forward_to, snooze
6. AI classification & folder learning
   - Lovable AI Gateway, learned profiles, surface-to-inbox rules, reclassify
7. Inbox & overrides
   - Always-inbox rules, inbox meta, realtime updates
8. Folder chat assistant
   - Proposed actions, durable per-folder memory, summarization
9. Contacts & cards (CRM)
   - Contact derivation, company grouping, My Card, public /c/$handle
10. Meetings
    - Calendar guard, auto-record, meeting bots, summaries, blocklists
11. Reports & analytics
    - Inbox report metrics, domain/sender clusters, histograms
12. Security & data handling
    - RLS scoping, pgcrypto token encryption, /api/public secret verification
13. Appendix: glossary of domain terms
```

Each feature section covers: purpose, how it works (technical detail), key tables/RPCs/files involved, and notable edge cases.

## Technical notes

- Build with `reportlab` (Platypus) for reliable multi-page flow, TOC, tables, and page templates; register a Unicode TTF for clean typography.
- ASCII/box diagrams rendered as styled flowables for the architecture and pipeline flows.
- No app code is modified — this is a generated document only.

## QA

Convert PDF to images at 150 DPI, inspect each page for overflow, overlap, clipped text, contrast, and ordering; iterate until clean. Report what was verified.
