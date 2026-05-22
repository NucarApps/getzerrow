## Goal

Make folder routing predictable when multiple rules match, and give folders richer matching + action options.

## Part 1 — Rule conflict / ordering

**Today:** within a folder, filters are OR for includes + AND-NOT for excludes. Across folders, highest `folders.priority` wins; ties are arbitrary. The user has no UI to see or control either.

**Proposed model (single, easy-to-reason-about order):**

1. Gmail label mapping (unchanged — Gmail's own labels stay authoritative).
2. Folder rules, evaluated by `folders.priority DESC, folders.name ASC` (stable tiebreaker).
3. AI classification fallback.

**Make priority a first-class UI concept:**
- Drag-to-reorder folder list = sets `priority`. Top = highest.
- Show a "Rule order" panel: when 2+ folders' rules match the same email, list them in evaluation order with the winner highlighted.
- On every email detail view, show `classification_reason` plus "also matched: Folder B, Folder C" so conflicts are visible.

**Per-email audit:** store the list of matched folder IDs (not just the winner) on `emails` so the UI can render "would have matched" and the user can promote/demote priority from there.

## Part 2 — AND/OR per folder

Add `folders.filter_logic` enum: `any` (OR, current default) | `all` (AND). Plus keep excludes as always-AND-NOT (industry standard — Gmail/Outlook both do this).

**UI per folder — "Match emails that…":**
- Radio: [Any of these rules] / [All of these rules]
- Rule rows (include): field, op, value
- "…and none of these" section for exclude rules

**Evaluation:**
- `any`: at least one include matches AND no exclude matches.
- `all`: every include matches AND no exclude matches.

**Advanced (optional, behind a "Show advanced" toggle):** rule groups, e.g. `(from contains @acme.com OR subject contains invoice) AND has_attachment`. Implemented as a JSON tree on the folder. Recommend deferring this to v2 unless you want it now — most users are well-served by simple any/all.

## Part 3 — Other folder options worth adding

**Matching fields** (extend `folder_filters.field`):
- `cc`, `bcc`, `reply_to`
- `list_id` / mailing-list header (huge for newsletters)
- `size_gt` / `size_lt`
- `is_reply` (has `In-Reply-To`)
- `received_time_of_day` (e.g. weekends → "Personal")
- `gmail_label` (route by existing Gmail label without a separate mapping)

**Actions** (extend `folders` table — already has `auto_archive`, `auto_mark_read`):
- `auto_star`
- `auto_forward_to` (email address)
- `auto_reply_template_id` (link to a reply_drafts template)
- `notify` (push/desktop notification when something lands here)
- `mute_notifications` (the inverse — silent folder)
- `pin_to_top` (UI sort)
- `auto_delete_after_days` (retention)
- `snooze_until_hour` (don't surface until 9am)
- `summary_schedule_id` (already exists via folder_summary_schedules — surface in folder settings UI)

**Behavior toggles:**
- `skip_ai` — never run AI fallback, rules-only.
- `ai_only` — never run filter rules, AI decides.
- `require_confidence_gte` — AI must be ≥ N% to assign here.
- `inbox_visibility`: show in inbox / hide from inbox / show only unread.

**Smart helpers:**
- "Learn from examples" — drag 5 emails in, auto-generate filter rules + AI profile (you already have `folder_examples` + `buildFolderProfile`; wire a "Suggest rules" button).
- "Test rule" — paste/select a recent email, see which folders match and why, before saving.
- "Dry run" — preview last 100 emails that would have been routed here if rule was active.

## Part 4 — Schema changes

```sql
ALTER TABLE folders
  ADD COLUMN filter_logic text NOT NULL DEFAULT 'any' CHECK (filter_logic IN ('any','all')),
  ADD COLUMN skip_ai boolean NOT NULL DEFAULT false,
  ADD COLUMN ai_only boolean NOT NULL DEFAULT false,
  ADD COLUMN min_ai_confidence real,
  ADD COLUMN auto_star boolean NOT NULL DEFAULT false,
  ADD COLUMN notify boolean NOT NULL DEFAULT false,
  ADD COLUMN hide_from_inbox boolean NOT NULL DEFAULT false;

ALTER TABLE emails
  ADD COLUMN matched_folder_ids uuid[] NOT NULL DEFAULT '{}';
```
(More columns added incrementally as features ship — list above is the v1 cut.)

## Part 5 — Scope for first PR

Recommend shipping in this order:
1. Schema + matcher change for `filter_logic` (any/all) + audit array.
2. Folder reorder UI → writes `priority`.
3. "Rule order" + "also matched" badges in email detail.
4. Then iterate on the extended actions and fields list above based on what you actually want.

## Open questions

1. Do you want simple **any/all** for v1, or jump straight to **rule groups** (nested AND/OR)?
2. Of the extended fields (cc, list_id, size, is_reply, etc.) — which matter to you? I can ship all or a subset.
3. Of the extended actions (auto_star, auto_forward, notify, hide_from_inbox, retention, snooze) — which are must-have vs nice-to-have?
4. Should AI fallback be per-folder opt-in (`ai_only`/`skip_ai`) or stay global?
