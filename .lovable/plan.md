## Verification of the 15:45 reconnect (step 0)

Queried `gmail_accounts`:

| email | needs_reconnect | refresh_token present | updated_at |
|---|---|---|---|
| chris@nucar.com | false | yes | 20:50:30Z |
| TPercoco@nucar.com | false | yes | 20:45:29Z |
| chris@dagesse.com | false | yes | 20:43:07Z |

Reconnect flow works end-to-end. So any duplicate-key errors we still see are a real ingest race, not a side-effect of the dead-OAuth state.

## 1. Short-circuit reconcile on `needs_reconnect`

`src/routes/api/public/gmail-reconcile.ts` currently selects every `gmail_account` and calls `reconcileLocalInbox` on each. For dead-OAuth accounts every Gmail roundtrip inside `reconcile` throws — same noise pattern poll and renew-watches already filter out.

Mirror the renew-watches pattern: add `.eq("needs_reconnect", false)` to the account select. One-line change; no logic change for healthy accounts.

## 2. Make every `emails` INSERT conflict-safe

There is a `UNIQUE(gmail_message_id)` index AND a `UNIQUE(gmail_account_id, gmail_message_id)` index, so any race that causes two ingest paths to touch the same message throws `23505` and aborts the surrounding batch. Three INSERT sites to fix:

**A. `src/lib/sync/process-message.ts:117` — primary ingest (push + poll)**
This is the hot path. Switch from `.insert({...}).select("id").single()` to `.upsert({...}, { onConflict: "gmail_message_id" }).select("id").single()`. DO UPDATE semantics are appropriate here: a re-delivered push should refresh `snippet`, `body_text`, `body_html`, `raw_labels`, `is_read`, `received_at`, `published_at_ms`. Keep `folder_id: null` / `classified_by: "pending"` only on first insert — guard by not including them in the upsert payload, OR accept that re-pushes will reset classification (cheap: step 2 reclassifies immediately). Recommend the latter for simplicity, matching the "re-fetch refreshes everything" intent.

**B. `src/lib/sync/folder-learn.ts:263` and `:388` — label-seed + load-older**
These are discovery walks; they already `.select(... gmail_message_id ...).in(...)` to skip known IDs, but a concurrent push between the select and the insert can still collide. DO NOTHING is the right semantic — the live ingest path owns content; the learner only assigns `folder_id`. Use `.upsert({...}, { onConflict: "gmail_message_id", ignoreDuplicates: true })`. After upsert returns 0 rows, do the existing `update({ folder_id, classified_by: "gmail_label", ... })` keyed on `gmail_message_id` so the learner still claims the row.

**C. `src/lib/gmail.functions.ts:1859` — `searchGmailAndIngest`**
Same as B — discovery path. `.upsert({...}, { onConflict: "gmail_message_id", ignoreDuplicates: true })` and treat the no-op case as "already had it" rather than an error.

Result: no INSERT in the codebase can ever throw `23505` for `gmail_message_id`. Batches stop aborting mid-stream.

## Files changed

- `src/routes/api/public/gmail-reconcile.ts` — add `needs_reconnect=false` filter
- `src/lib/sync/process-message.ts` — `.insert` → `.upsert(..., { onConflict: "gmail_message_id" })`
- `src/lib/sync/folder-learn.ts` — two inserts → `.upsert(..., { onConflict: "gmail_message_id", ignoreDuplicates: true })` + claim-by-message-id update
- `src/lib/gmail.functions.ts` (searchGmailAndIngest) — same treatment

Pure backend hygiene; no schema migration, no UI change.