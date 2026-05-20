## What's happening

Clicking "Next" on a Gmail-linked folder (e.g. School) calls `loadOlderFromGmail` with `before_received_at` set to the last row's `received_at`. That value comes from Postgres/PostgREST and looks like `2025-05-20T14:50:33.123456+00:00` — it has a timezone offset (and often microseconds).

The server validator is:

```ts
before_received_at: z.string().datetime().nullable()
```

`z.string().datetime()` only accepts `Z`-suffixed ISO strings by default. Anything with a `+00:00` offset is rejected → the Zod error you saw (`invalid_format / datetime` on path `before_received_at`).

## Fix

In `src/lib/gmail.functions.ts` (`loadOlderFromGmail`, line 164), allow timezone offsets:

```ts
before_received_at: z.string().datetime({ offset: true }).nullable()
```

That's the only required change. No client changes, no schema changes.

## Quick audit while there

Grep the rest of `gmail.functions.ts` / other server fns for `z.string().datetime()` used on values that originate from Postgres timestamps, and apply the same `{ offset: true }` fix wherever it appears (read-only check — only patch ones actually fed by DB values).

## Out of scope

- Pagination logic itself (cursor handling in `index.tsx`) — it's correct, only the validator was wrong.
- Normalizing timestamps to `Z` on the client — not worth it; accepting offsets is the standard fix.
