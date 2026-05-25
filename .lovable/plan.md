# Space Invaders leaderboard + stats

## Database (one migration)

New table `public.game_scores`:
- `id uuid` (PK, default gen_random_uuid)
- `user_id uuid not null` (= `auth.uid()` at insert)
- `game text not null default 'invader'` (room for future games)
- `score integer not null check (score >= 0 and score <= 10000000)`
- `display_name text not null` (snapshotted at insert so the leaderboard never exposes emails or future name changes)
- `created_at timestamptz not null default now()`
- Indexes: `(game, score desc)`, `(user_id, score desc)`

RLS:
- `Users insert own scores`: INSERT, `auth.uid() = user_id`
- `Users view own scores`: SELECT, `auth.uid() = user_id`
- No public SELECT — leaderboard data is exposed only via a SECURITY DEFINER RPC that projects safe columns (`display_name`, `score`).

RPC `public.get_invader_stats()` (SECURITY DEFINER, `set search_path = public`):
Returns a single jsonb:
```
{
  myBest:     int | null,
  globalBest: int | null,
  myRank:     int | null,   // dense rank by best score across all users
  top5: [ { name: text, score: int } ]  // best-per-user, top 5 desc
}
```
Computes `myBest` from `auth.uid()`, `globalBest` from `max(score)`, `top5` from `(distinct on user_id) order by score desc limit 5`, `myRank` from `count(distinct user_id) where best > myBest) + 1`.

## Server functions (`src/lib/invader.functions.ts`)

- `submitInvaderScore` — `createServerFn` + `requireSupabaseAuth`. Zod-validates `score` (int 0..1e7). Looks up the user's display name from `my_cards` (`name` → `handle` → `'Player'`). Inserts a row. Returns the new stats by calling the RPC.
- `getInvaderStats` — `createServerFn` + `requireSupabaseAuth`. Calls the RPC and returns the jsonb.

## UI (`src/components/inbox/TrackingStandby.tsx`)

- Add a `useQuery({ queryKey: ['invader-stats'], queryFn: getInvaderStats })`.
- When `phase` transitions to `"over"`, fire `useMutation(submitInvaderScore)` once per game with the final `score` (skip if score === 0). On success, `setQueryData(['invader-stats'], ...)` from the mutation response (and invalidate as fallback).
- Add a compact stats panel inside the existing overlay (only visible on `ready` and `over`, hidden during `playing`/`paused` so it doesn't cover gameplay). Two parts, both in the JetBrains Mono / tracked-uppercase style already used by the overlay:

  ```
  MY BEST 01240   ·   GLOBAL BEST 08120   ·   YOUR RANK #14
  ─────────── TOP PILOTS ───────────
  1  STARLORD   8120
  2  ANNA       6440
  3  …
  ```

  Right-align scores, truncate names to ~14 chars, dim rows below the user's rank. If `myBest` is null show `—`; if `top5` is empty show "BE THE FIRST PILOT".

- Keep all existing colors, fonts, and layout; new panel uses existing tokens (`text-muted-foreground`, `#ffd089` accent).

## Out of scope

- No name input UI (uses card name automatically; users can rename via My card).
- No per-level breakdowns or historical chart.
- No anti-cheat / score signing.
- No changes to gameplay, controls, or power-ups.
