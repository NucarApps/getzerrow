## Problem

The bulk **Select all → Re-classify** controls only render in the special **No rules** view (gated behind `isNoRules` in `src/routes/_authenticated/inbox.tsx:1189`). When you open a real folder like **GM Responses**, there is no Select all and no Re-classify — the only way to reprocess is opening each email and clicking the ↻ Re-analyze button individually. For a folder with ~236 emails that's not practical.

## Goal

Add a one-click **Reanalyze folder** action to the folder view that reprocesses every email in the currently selected folder, using the exact same classification + eviction logic as the existing single-email Re-analyze and bulk Re-classify (try to re-file into a better folder first; kick to the inbox only when the folder's own rules veto the sender and nothing else claims it).

## Approach

Reuse the existing, already-shipped `reclassifyEmails` server function (caps at 100 ids per call) and drive it in batches from the client. This avoids a long-running single server request (which could hit the Worker execution-time limit when each email may make an AI call) and reuses proven logic — no new classification code.

### 1. Server: list email IDs for a folder

Add a small `createServerFn` (e.g. `listFolderEmailIds`) in `src/lib/gmail.functions.ts`:
- Input: `{ folder_id: string }` (uuid).
- Auth via `requireSupabaseAuth`; verify the folder belongs to `context.userId`.
- Return `{ ids: string[] }` — all `emails.id` where `folder_id = folder_id` and `user_id = context.userId` (no decryption needed; just IDs).

### 2. Client: Reanalyze folder button

In `src/routes/_authenticated/inbox.tsx`, add an icon button (↻ with a label/tooltip "Reanalyze folder") in the folder-list header (next to the existing Refresh / Assistant buttons around lines 1133–1153). Show it only when a real folder is selected — i.e. `currentFolderObj` is non-null (already computed at line 935) — so it doesn't appear for All mail / No rules / Inbox.

On click:
- Confirm with a small dialog since it can move many emails ("Reanalyze all N emails in {folder}? Emails whose sender your folder rules no longer allow will be moved to a better folder or back to the inbox.").
- Call `listFolderEmailIds` to get all IDs.
- Loop in chunks of 100, calling the existing `reclassifyEmails` for each chunk, accumulating `routed` / `unchanged` / `failed`.
- Show progress via an updating toast ("Reanalyzing… 100 / 236") and a final summary toast ("Reanalyzed {folder} · X routed, Y unchanged, Z failed").
- Invalidate the `["emails"]` and `["emails-summary"]` queries at the end so the list and folder counts refresh.
- Disable the button while running (reuse a busy flag pattern like the existing `reclassifyBusy`).

### 3. Behavior guarantees (unchanged)

- Each email runs the full classifier: deterministic rules first, then AI across eligible folders.
- A vetoed current folder (e.g. GM Responses' `domain_in` allowlist / `not_contains sullivanlaw.com`) is excluded from candidates, so the email is re-filed elsewhere if something fits, otherwise restored to the inbox (INBOX label added, folder label removed in Gmail) — keeping Gmail in sync so the next sync won't revert it.
- Transient `ai_error` never evicts an email.

## Verification

- Open GM Responses → click Reanalyze folder → confirm → watch progress toast → external-domain emails (e.g. sullivanlaw.com) leave the folder (to inbox or a better folder), the folder count drops, and legitimately-belonging mail stays.
- Confirm the button does not appear in All mail / Inbox / No rules views.
- Re-run a folder that's already clean → everything reports "unchanged", nothing moves.
- Typecheck + existing filter-engine / reclassify tests stay green.

## Files

- `src/lib/gmail.functions.ts` — add `listFolderEmailIds` server function.
- `src/routes/_authenticated/inbox.tsx` — add the Reanalyze folder button, confirm dialog, batched loop, and progress/summary toasts.
