## Why it's slow today

`learnFromLinkedLabel` in `src/lib/sync.server.ts` walks the linked Gmail label and, for every message (up to **2000**), does this **one at a time**:

1. `getMessage(id)` with `format=full` — full headers + plain text + HTML body. One HTTP round-trip per email.
2. Upsert into `folder_examples`.
3. SELECT `emails` to see if it already exists.
4. INSERT or UPDATE `emails`.

For a "Cold Email" label with hundreds/thousands of messages, that's hundreds of sequential Gmail API round-trips followed by a synchronous AI profile generation. The button shows "Learning…" the whole time and frequently feels like it hangs.

The profile itself is built from at most **50** examples (`regenerateFolderProfile` orders `created_at desc limit 50`), so fetching 2000 full message bodies is mostly wasted work.

## Plan

### 1. Drastically reduce the work per click (`src/lib/sync.server.ts`)

In `learnFromLinkedLabel`:

- Lower `MAX_MESSAGES` from **2000 → 200** for the on-click path. The learned profile only uses the latest 50; 200 gives healthy headroom for "new since last learn" without blowing up cost.
- Only fetch IDs we don't already have. Before fetching, query `folder_examples` for `gmail_message_id IN (...)` for this folder and skip those — re-learn on a folder that was already learned should be near-instant.
- Use `format=metadata` (headers only: From, Subject) instead of `format=full`. We only persist `from_addr`, `subject`, `snippet` into `folder_examples`. Snippet comes from the message resource directly, no body parsing needed. This roughly halves payload size and parse time.
  - Add a `getMessageMetadata(accountId, id)` helper in `src/lib/gmail.server.ts` that calls `/users/me/messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`.
  - Reuse the existing `parseMessage` header logic (it doesn't require a body).
- Parallelize the per-message work with a small concurrency pool (e.g. **10** at a time) instead of a serial `for` loop. This is the single biggest win — 10× fewer wall-clock seconds for the same number of messages.
- Keep the "ingest into `emails` table" branch, but only run it for messages we actually fetched (i.e. not already-known examples). For "learn", it's acceptable to skip the full-body insert into `emails` and let normal sync pick those up — the learning step's job is the profile, not full inbox ingestion. We'll keep the lightweight insert path but without `body_text` / `body_html` (those require `format=full`).

### 2. Tighten the listing call

- The first `listMessages` page already returns up to 500 IDs. With the new 200 cap, we never need pagination — drop the `do/while` and just take the first page. This removes one extra Gmail round-trip in the common case.

### 3. Surface progress to the user (`src/components/folders/FolderEditor.tsx`)

Small UX change so it doesn't feel like a hang while the (now much shorter) batch runs:

- Replace the static "Learning…" label with a count-driven message ("Learning from up to 200 emails…") and an indeterminate progress indicator inline next to the button.
- No backend job/queue infrastructure — once #1 lands, the call typically finishes in a few seconds, so a simple spinner + clearer label is enough.

### 4. Out of scope

- No background-job system, no polling, no new tables. The current synchronous server function stays — it just gets fast.
- No change to AI classification, exclude logic, `matched_filter_ids`, or the "Why this folder?" panel.
- No change to the periodic auto-relearn triggered after manual moves.

## Technical notes

- The Gmail `messages.get?format=metadata` endpoint requires `metadataHeaders` query params; without them it returns no headers. We must list both `From` and `Subject`.
- `parseMessage` already tolerates missing body parts (it returns empty strings), so calling it on a metadata-only payload is safe — `body_text`/`body_html`/`has_attachment` will be empty/false, which is fine because we no longer insert those during learn.
- Concurrency pool: a tiny `Promise.all` over chunks of 10, no new dependency.
- Expected end-to-end time for a folder with ~200 unseen messages drops from "minutes" to roughly the time of 20 sequential Gmail round-trips (~3–6 s) plus one AI profile call.
