# iOS Contacts Sync — Technical Spec PDF

Produce a downloadable PDF that documents exactly how Zerrow syncs contacts to iOS (CardDAV), plus the Google Contacts side where it interacts. Documentation only — no app code changes.

## Deliverable

`ios-contacts-sync-spec.pdf` in your files, styled with Zerrow's dark/brand look, roughly 8-12 pages, generated from the actual code in the repo (endpoints, tables, settings, decision rules) so it stays accurate rather than generic.

## Contents

1. Overview and diagram — iPhone (native Contacts) ↔ CardDAV endpoint ↔ Zerrow database ↔ Google Contacts.
2. Endpoint and protocol — single splat route `/api/public/carddav/*`, supported methods (OPTIONS, PROPFIND, REPORT, GET/HEAD, PUT, DELETE), RFC 6578 sync-collection support, 12 MB body cap.
3. Authentication — Basic auth with per-device app passwords, hashed at rest, create/revoke flow, why the public prefix is safe.
4. iPhone setup — how a device is added, address book layout, what the user sees.
5. Data mapping — vCard field mapping for names, phones (normalization, extensions), emails, company/title, notes (AI summary block vs. user notes separation), CATEGORIES for groups.
6. Groups — nested group model, flat presentation on iOS, group naming styles (group / group - company), auto company subgroups, live preview in settings.
7. Photos — personal vs. company-logo priority setting, upload from iPhone saved as personal photo, the photo-echo protection that stops company logos being saved back as personal avatars, hash/etag logic.
8. Change handling — ETags, resync nonce, non-destructive field patching on PUT, revision history/undo, tombstones for deletes.
9. Google Contacts interaction — two-way sync, Zerrow as source of truth, photo push/pull, rate-limit and quota handling.
10. Settings reference — every CardDAV-related toggle and what it changes.
11. Failure modes and troubleshooting — auth failures, stale sync tokens, quota errors, forced resync.
12. Security and privacy — token hashing, RLS scoping, private photo bucket with signed URLs.

## Technical notes

Generated with a Python/reportlab script in `/tmp` (not added to the repo). Every page will be rendered to images and visually inspected for overflow, clipping, and contrast before delivery.
