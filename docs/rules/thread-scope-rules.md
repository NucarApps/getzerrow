# Task 6 — Thread-scope rules (`folders.run_on_threads`)

A folder with `run_on_threads=true` evaluates its deterministic rules
against the whole thread: the incoming message plus up to 10 recent prior
messages (decrypted, bodies truncated to 10k chars). A reply in a thread
whose earlier message matched still routes into the folder.

## Semantics (`matchByFiltersOnThread` in `filter-engine.ts`)

- Include rules (simple filters or trees) are evaluated **per message**
  across `[incoming, ...prior]` — a folder matches when ANY single
  message satisfies the full rule. Fields are never mixed across
  messages (an `all` rule can't take its subject from one message and
  its sender from another).
- Exclude/veto rules always evaluate against the **incoming** message —
  routing decisions veto on the mail actually being routed.
- Priority ordering is shared across thread- and message-scoped folders,
  so a thread match never jumps the priority queue.
- `matched_via_thread` reports when only a prior message matched;
  `classifyByRules` appends "(matched an earlier message in this
  thread)" to the classification reason (visible in Rule activity).

## Gating & cost

Default `false` — existing folders keep exact message-scope behavior,
and the thread fetch (`src/lib/sync/thread-context.ts`) is skipped
entirely unless at least one folder in the account opted in
(`threadScopeEnabled`). The fetch is bounded (10 messages, 10k chars per
body) and best-effort: on any error the email just classifies
message-scoped.

## Tests

`filter-engine.thread.test.ts` (9): prior-message match routes, gating
without the flag, direct-match flagging, per-message `all` semantics,
tree evaluation across the thread, veto-on-incoming-only, shared
priority ordering, and `classifyByRules` wiring incl. the reason note.
