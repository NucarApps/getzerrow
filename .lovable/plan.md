
# Contacts & Card Exchange

A new section inside Zerrow that turns the people you already email with into a real contact directory, gives you a shareable business card (link + QR), lets you scan paper cards with your phone, and emails your card back when you save someone — closing the exchange loop.

## What you get

1. **Contacts** — auto-built from your inbox. Every unique `from_addr` becomes a contact. Open one and we enrich on-demand: name, title, company, phone, website, socials, avatar (Gravatar fallback) — all pulled from their recent email signatures with AI.
2. **My Card** — your own profile/business card. Public shareable page at `/c/<your-handle>` with a vCard download and a QR code for in-person exchange.
3. **Scan a card** — upload a photo of a paper business card from your phone; Gemini Vision extracts the fields; you confirm and save. Creates the contact.
4. **Exchange** — when you save a scanned card (or save a contact and tick "send my card"), we email them your card (vCard attachment + link).

## Where it lives

- New sidebar item **Contacts** under Inbox/Reports.
- Routes:
  - `/contacts` — list/search
  - `/contacts/$id` — detail + edit + "Send my card"
  - `/contacts/scan` — camera/upload flow
  - `/my-card` — edit your own card
  - `/c/$handle` — public card page (no auth)

## Data model (new tables)

- `contacts` — `user_id, email, name, title, company, phone, website, linkedin, twitter, avatar_url, notes, source ('email'|'scan'|'manual'), enriched_at, created_at`. Unique on `(user_id, lower(email))`.
- `contact_cards_sent` — log of who you sent your card to (for de-dupe + UI).
- `my_cards` — `user_id (unique), handle, name, title, company, email, phone, website, linkedin, twitter, avatar_url, tagline, theme`. Public RLS: anyone can `SELECT` by handle (only safe fields).

All tables RLS-scoped to `auth.uid()` except the public read on `my_cards` by handle.

## How each piece works

**Auto-contact build.** A server fn `backfillContacts` groups `emails` by `from_addr` and upserts a row per unique sender (name from `from_name`, source `'email'`). Runs once on first visit to `/contacts`, then incrementally when new mail arrives. No AI cost.

**On-demand enrichment.** Opening a contact triggers `enrichContact(id)` if `enriched_at` is null/stale:
- Pull last ~5 emails from that sender (`body_text` + signatures).
- Call Lovable AI (`google/gemini-2.5-flash`) with a JSON-schema prompt to extract `{name, title, company, phone, website, linkedin, twitter}`.
- Save + stamp `enriched_at`. Re-enrich button in the UI.

**Card scanning.** `/contacts/scan` uses `<input type="file" accept="image/*" capture="environment">` — opens the phone camera on mobile, file picker on desktop. Image → base64 → server fn `scanCard` → Gemini Vision (`google/gemini-2.5-flash` with image modality) extracts fields → returns draft → user confirms → saves as contact with `source='scan'` → optional "send my card back" checkbox triggers exchange.

**My Card.** `/my-card` is a form (pre-filled from Google profile on first load). Save writes `my_cards`. Public page `/c/$handle` renders the card, shows a QR (qrcode.react) pointing to itself, and offers **Download vCard** (generates `.vcf` client-side).

**Exchange (sending your card).** Server fn `sendMyCard(toEmail)`:
- Loads your `my_cards` row.
- Builds a vCard string + a short HTML email with your card link.
- Sends via Gmail API using your existing OAuth token (we already have `access_token` in `gmail_accounts`) — no new sender infra needed. Uses `users.messages.send` with `multipart/mixed` (HTML + `.vcf` attachment).
- Logs to `contact_cards_sent`.

## Technical notes

- Server functions in `src/lib/contacts.functions.ts`, `src/lib/cards.functions.ts`, with `.server.ts` helpers for Gmail send + AI calls.
- Reuse `requireSupabaseAuth` middleware and the existing `gmail_accounts` token refresh flow in `src/lib/gmail.server.ts`.
- Public `/c/$handle` route uses a public server fn with `supabaseAdmin` scoped by handle, returning only safe columns.
- New deps: `qrcode.react` (QR), no others — vCard is a short text format we build inline.
- AI: Lovable AI gateway, no extra secrets needed.

## Scope boundaries (v1)

- No CRM features (deals, pipelines, reminders).
- No org/company grouping — flat contact list with search/filter.
- No bulk enrich — on-demand only to control AI cost.
- No live camera UI — file input with `capture` attribute (works as camera on mobile).
- vCard 3.0 only; no Apple Wallet pass.

## Build order

1. Migration: `contacts`, `my_cards`, `contact_cards_sent` + RLS.
2. Sidebar entry + `/contacts` list with backfill from `emails`.
3. Contact detail + on-demand AI enrichment.
4. `/my-card` editor + public `/c/$handle` page + QR + vCard download.
5. Gmail-send helper + `sendMyCard` server fn.
6. `/contacts/scan` flow + "send my card back" toggle.
