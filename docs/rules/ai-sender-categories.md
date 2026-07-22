# AI sender categories (rules upgrade, task 7)

Folder rules can target AI-inferred sender kinds without a separate
`Category` table: a nightly cron labels recent senders and maintains
ordinary contact groups with `kind='ai_category'`, which the existing
`sender_in_group` filter op picks up automatically.

## Data model

`contact_groups.kind TEXT NOT NULL DEFAULT 'manual'`
(`CHECK (kind IN ('manual','ai_category','imported'))`) — additive
migration `20260722010737_contact_groups_kind.sql`; every existing row
stays `'manual'` and nothing else changes shape. RLS on
`contact_groups` / `contact_group_members` is unchanged
(`auth.uid() = user_id`).

## Nightly cron

`POST /api/public/hooks/categorize-senders` (scheduled 03:17 UTC via
`private.cron_post`, job `categorize-senders-nightly`) → fails closed
through `isAuthorizedCronRequest` like every other hook.

Per user (users with a connected Gmail account, capped at 50/run):

1. Pick up to **25** recent contacts with an email address that are not
   yet members of any `ai_category` group (uncategorized senders drain
   over successive nights).
2. One **batched, timeboxed** call through the Lovable AI gateway
   (`AI_CLASSIFY_ATTEMPT_TIMEOUT_MS`) asks for exactly one label per
   sender from a fixed set: `recruiter, vendor, newsletter, customer,
   personal, service`. Only addresses + display names are sent — never
   email bodies. The reply is Zod-validated; unknown labels are skipped,
   never guessed.
3. Find-or-create the matching group (`Recruiters`, `Vendors`, …) with
   `kind='ai_category'`. A same-named **manual** group is never
   hijacked — the sender is skipped instead. Memberships upsert on the
   `(group_id, contact_id)` primary key, so re-runs are idempotent.

Per-user failures are isolated (`categorize_senders.user_failed`) so one
user's AI error can't starve the run.

## Rules integration

No filter-engine change: `sender_in_group` already matches against every
group the sender belongs to (`AccountContext.senderGroups`), so an
AI-derived group becomes usable in folder rules the moment it gains
members.

## UI

`listContactGroups` now returns `kind`; AI-derived groups show an
**AI** badge in the contacts sidebar (tooltip explains they're
maintained nightly). They behave like normal groups everywhere else.

## Tests

`src/lib/contacts/categorize-senders.test.ts` — deterministic labeling
with an injected fake AI fn, unknown-label skipping, manual-group
collision safety, and idempotency (already-categorized contacts are not
re-picked and the AI is not called).
