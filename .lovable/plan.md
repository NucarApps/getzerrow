## Goal

In the "Why this folder?" panel, only show the folder rules that **actually triggered for this specific email** (not the entire rule list), and make sure that match is persisted so we never fall back to "Specific match not recorded".

## Current behavior (what's wrong)

- `TriggeredBy` in `src/routes/_authenticated/index.tsx` renders `classification_reason` plus the folder's **entire** `folder_filters` list under "All rules for {folder}" — that's why you see all 16 domains.
- For older emails synced before reasons were recorded, `classification_reason` is `null`, so the panel shows the italic "Specific match not recorded" fallback even though we could compute the match now.

## Plan

### 1. Persist the matched rules going forward (sync)

In `src/lib/sync.server.ts`:

- Change `matchByFilters` to return **all** include-hits for the winning folder (not just the first), e.g. `matched_filters: Filter[]` on the `"match"` result.
- On insert in `classifyAndStore`, write those into a new column `matched_filter_ids uuid[]` on `emails` (snapshot of the filter ids that fired).
- Keep `classification_reason` as the short human string (no change to that field's semantics).

Migration: add `matched_filter_ids uuid[] default '{}'::uuid[]` to `public.emails`. Nullable-safe, no backfill needed.

### 2. Compute matched rules client-side for legacy emails

In `src/routes/_authenticated/index.tsx`:

- Port the small `applyFilter` logic (from `sync.server.ts`) into a tiny pure helper in the route file (it only needs the email's `from_addr`, `subject`, `body_text`, etc., which we already have on the selected email).
- In the existing `folder-rules` query, after loading `folder_filters`, compute the subset that matches the current email.
- Selection rule for what to display:
  1. If `email.matched_filter_ids` is set → show those rows from `folder_filters`.
  2. Else (legacy email) → show the client-computed matching subset.
  3. If neither produces any rows (edge case: rules changed since classification), fall back to today's full list with a small note "Rules have changed since this email was classified."

### 3. UI tweaks in `TriggeredBy`

- Rename the section header from "All rules for {folder}" to **"Rule that matched"** (or "Rules that matched" when >1).
- Drop the italic "Specific match not recorded" copy — once #2 is in, we always have something concrete to show.
- Keep the existing `excluded` / `ai` / `gmail_label` / `manual_move` / `global_exclude` branches untouched.

### 4. Out of scope

- No changes to AI classification, exclude logic, or the move-similar dialog.
- No change to how the chip at the top renders (still "RULE" / "AI" / etc.).

## Technical notes

- New column is additive; existing `select("*")` paths pick it up automatically after types regenerate.
- `matchByFilters` return shape change is internal — only `classifyAndStore` consumes it.
- Client-side `applyFilter` mirror must stay in sync with the server version; I'll add a short comment in both files pointing at each other.
- No behavior change for folders that were matched by Gmail label, manual move, AI, or global exclude — `matched_filter_ids` stays empty for those.