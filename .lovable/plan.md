## What's happening

Mail auto-forwarded by an ex-employee's account (kconnor@nucar.com — 78 messages in the last 3 days) arrives with `From: kconnor@nucar.com`, so:

- `emails.from_addr` = the forwarder, not Manheim.
- "Filter messages like this → match by sender" seeds from `from_addr`, so the rule targets the forwarder.
- `emails` has no `reply_to`, `sender`, `return_path`, or `x-forwarded-for` column (verified against the live schema), and `parseMessage` in `src/lib/gmail.server.ts` only reads From/To/Cc/List-Id/In-Reply-To/Subject. The original sender is present in the Gmail headers today but we discard it.

## Plan

### 1. Capture the originating-sender headers

In `parseMessage`, additionally read `Reply-To`, `Sender`, `Return-Path`, `X-Forwarded-For`, `X-Original-From`, and `X-Original-Sender`, and derive:

- `reply_to_addr`
- `origin_addr` — the best guess at the true sender, chosen in this order: `X-Original-From` / `X-Original-Sender` → `Reply-To` (when its domain differs from From) → `X-Forwarded-For` original address → `Return-Path`/`Sender` (when it differs from From) → fall back to `from_addr`.
- `is_forwarded` — true when `origin_addr` differs from `from_addr`.

Keep this a pure helper (e.g. `src/lib/gmail/origin-sender.ts`) with unit tests, mirroring the existing pure-logic convention.

### 2. Store it

Migration adding to `public.emails`: `reply_to_addr text`, `origin_addr text`, `origin_name_enc` (encrypted, same pattern as `from_name_enc`), `is_forwarded boolean not null default false`; index on `origin_addr`. Wire through `email-upsert.ts`, `encrypted-writer.ts`/`encrypted-reader.ts`, and the RPCs those call. Existing rows keep `origin_addr = null` and behave exactly as today.

### 3. New rule fields

Add to the filter engine (`applyFilter`): `origin_from`, `origin_domain`, `reply_to`. `origin_*` falls back to `from_addr` when the message wasn't forwarded, so a rule on `origin_domain = manheim.com` catches both direct and forwarded Manheim mail. Add the three options to `FIELD_OPTS` in `folder-rule-group-editor.tsx` and to the field list used by the simple rule builder / simulator.

### 4. UI: pick which sender to match

In `FilterLikeThisDrawer`, when the email is forwarded, show the sender choice as two radio rows instead of one:

```text
Sender    ( ) kconnor@nucar.com        (forwarded by)
          (•) sales@manheim.com        (original sender)
Domain    ( ) nucar.com   (•) manheim.com
```

Default to the original sender when `is_forwarded`. The chosen row writes an `origin_from` / `origin_domain` rule; picking the forwarder writes the current `from` / `domain` rule. Unforwarded mail keeps today's single-value UI unchanged.

Also surface "via kconnor@nucar.com" as a small line in the email detail header and in `AiDecisionDrawer` so it's obvious why a rule matched.

### 5. Backfill

One-off pass (reuse the existing reprocess path) to re-parse recent messages from the known forwarding accounts and populate `origin_addr` so historical mail becomes matchable by the new rules. Scoped by account + date range, run on request rather than automatically.

## Technical notes

- No change to classification precedence: the AI path and existing `from`/`domain` rules behave identically for non-forwarded mail.
- Inbox overrides get the same origin-aware treatment so an always-inbox entry on the real sender works for forwarded copies.
- Tests: origin-header parser unit tests, `filter-engine` cases for the three new fields incl. the fallback-to-`from_addr` behavior, and a drawer test that a forwarded email seeds the original sender.

## Open question

If Manheim's mail is arriving through a mailbox that no longer belongs to anyone, the cleaner long-term fix is to stop the forward at Google Workspace and have Manheim send directly. This plan makes Zerrow handle it either way, but worth flagging.
