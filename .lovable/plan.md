# Fix reanalyze "failed" spikes on large folders

## What happened

Your "GM Responses" folder held ~584 emails (194 + 190 + 200). Reanalyze sends them to the server in chunks of **100**, and the server classifies each chunk **one email at a time** — an AI call plus DB reads/writes per email. A 100-email chunk takes ~100 seconds and hundreds of subrequests inside a single Cloudflare Worker request, so two of the six chunks hit the Worker time/subrequest limit and the whole request errored.

The client counts a thrown chunk as `failed += chunk.length`, which is why you saw exactly **200 failed** (two × 100), not 200 individual email failures. The AI itself is fine — the gateway logs show zero errors. Nothing is broken: the two failed chunks were never applied, so re-running picks them up normally.

## The fix

The goal is to make each server request small enough to always finish, and to stop one slow request from throwing away 100 results.

### 1. Shrink the batch size (`src/routes/_authenticated/inbox.tsx`)
- In `runReanalyzeFolder`, lower `chunkSize` from `100` to `25`. Four smaller requests finish comfortably inside Worker limits instead of one oversized request timing out. Progress toast still updates per chunk.

### 2. Retry a failed chunk once before giving up (`src/routes/_authenticated/inbox.tsx`)
- Wrap the `reclassifyFn` call so that if a chunk throws, it retries the same chunk one more time before counting it as failed. A single transient timeout then self-heals instead of dumping 25 emails into `failed`.

### 3. Match the server cap to the new batch size (`src/lib/gmail.functions.ts`)
- Change the `reclassifyEmails` input validator `.max(100)` to `.max(50)` so the server can never be handed an oversized batch that is guaranteed to time out. (50 leaves headroom above the new client chunk of 25 without allowing the old 100.)

## Result

Reanalyzing large folders will complete with routed/unchanged counts and `failed: 0` in normal conditions. If a chunk still times out once, the retry recovers it; only a genuinely repeatable error would show as failed, and it would be at most 25 at a time instead of 100.

## Note
No schema, RLS, or classification-logic changes — this is purely batching and error-handling on the reanalyze path. You can safely re-run "Reanalyze" on GM Responses now and the previously-failed 200 will be processed.
