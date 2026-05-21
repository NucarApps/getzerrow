## Diagnosis

Tony's Factory-Nissan folder has **zero** `folder_filters` rows, even though he intended to set up a "@nissan-usa.com → Factory-Nissan" rule. He has 84 emails from `@nissan-usa.com` sitting un-foldered (`classified_by = gmail_search_ingest`, `folder_id = NULL`).

Root cause: the "Move similar — same domain" flow (`MoveSimilarDialog` → `bulkMoveEmails`) only moves the matched emails as `manual_move`. It **never inserts a `folder_filter` row** on the destination folder. So:

1. The one-time move worked for whatever was in his Inbox at that moment.
2. The bulk Gmail backfill (`searchGmailAndIngest`, which pulls older mail by domain) does not consult `folder_filters` — it only honors Gmail labels — so the 84 backfilled rows landed un-foldered.
3. Future inbound mail won't auto-route because the classifier in `sync.server.ts` requires a `folder_filter` row to produce a `domain_rule` classification.

Net effect: from the user's perspective, "Move similar by domain" looks like it sets up a rule, but it's actually a one-off bulk move.

## Fix

### 1. Persist the rule when moving by domain/sender
Extend `bulkMoveEmails` (in `src/lib/gmail.functions.ts`) with an optional `create_rule?: { field: "domain" | "email"; value: string }` input. When present:
- Idempotently insert a `folder_filters` row (`field`, `op="contains"`, `value`) on the destination folder.
- Tag the moved rows as `classified_by = "domain_rule"` (or `"filter"` for sender) with reason `"Domain rule: <value> → <folder>"` instead of `"manual_move"`, so the audit trail matches the new rule.

Update `MoveSimilarDialog.tsx` `confirmMove()` to pass `create_rule` derived from current `mode` (`domain` → field `domain`/value `domain`; `sender` → field `email`/value `fromAddr`).

### 2. Apply existing folder rules during Gmail search ingest
In `searchGmailAndIngest` (same file, ~line 1493), after loading folders, also load this user's `folder_filters` and reuse the same matching logic that `sync.server.ts` uses (already a small helper `matchFilter`). When a parsed message matches a filter, set `folder_id`, `classified_by = "domain_rule"` / `"filter"`, and `ai_confidence = 1` instead of the current `gmail_search_ingest` default. This closes the loop so the user's rules apply consistently to fresh sync, push events, and backfill.

### 3. Backfill Tony's data
One-shot migration:
- Insert `folder_filters(folder_id = Factory-Nissan, field='domain', op='contains', value='nissan-usa.com')`.
- Update the 84 stuck rows: `folder_id = Factory-Nissan`, `classified_by = 'domain_rule'`, `ai_confidence = 1`, `classification_reason = 'Domain rule: nissan-usa.com → Factory-Nissan'`, `is_archived = true` (matches folder semantics).

Note: this migration won't add the Gmail `Label_24` label or remove `INBOX` on those 84 messages in Gmail itself, because migrations can't call the Gmail API. Two options:
- (a) leave Gmail alone — Zerrow shows them in the folder, Gmail still shows them in Inbox. Acceptable since the going-forward rule will sync labels for new mail.
- (b) Add a small server route Tony triggers once ("Sync 84 Nissan emails to Gmail label"), which iterates and calls `modifyMessage`. Recommend (a) for simplicity; flag (b) only if Tony cares about Gmail-side cleanup.

## Files to change

- `src/lib/gmail.functions.ts` — extend `bulkMoveEmails`, update `searchGmailAndIngest`.
- `src/components/emails/MoveSimilarDialog.tsx` — pass `create_rule`.
- New migration — insert filter row + reclassify the 84 emails for Tony.

## Verification

- Tony's `folder_filters` shows the new nissan-usa.com row.
- His 84 nissan emails appear under Factory-Nissan with badge "Domain rule".
- New nissan-usa.com email triggers a `domain_rule` classification on push (visible in Activity panel).
- A fresh "Move similar — same domain" by any user creates both the filter row and the moved emails in one action.

## Out of scope

- Gmail label sync for the 84 backfilled emails (Plan B above).
- UI to manage `folder_filters` directly (folder editor already has rule chips).
