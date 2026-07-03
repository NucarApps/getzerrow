## Problem

Clicking **Re-analyze** (the ↻ icon) on an email whose current folder now rejects it via a deterministic rule (an allowlist `domain_in` or a `not_contains` exclude) leaves the email where it is and shows "No better folder — kept in {folder}." Concretely: `lsteinberg@sullivanlaw.com` is in **GM Responses**, which carries both a `domain_in` allowlist that excludes `sullivanlaw.com` and an explicit `not_contains sullivanlaw.com` — yet Re-analyze keeps it there.

## Root cause

Two "reprocess" code paths behave differently:

- **Bulk Re-classify** (`reclassifyEmails`, `src/lib/gmail.functions.ts`) already restores any email to the inbox when the classifier assigns no folder and the reason is not a transient `ai_error`. This correctly evicts vetoed mail.
- **Single-email Re-analyze** (`reanalyzeEmail`, same file) only restores to the inbox when the reason is an **inbox override**. For every other no-folder outcome — including a folder's own allowlist/exclude rule vetoing the sender — it hits the "keep current assignment" branch and returns `classified_by: "kept"`.

Because the sender isn't matched by any GM Responses *include* filter, `matchByFilters` returns `null` rather than an explicit "excluded", so the veto never surfaces as a move — the email just stays put.

## Fix

Make single-email Re-analyze evict to the inbox in the same deterministic cases the bulk path already handles, so the two buttons agree.

In `reanalyzeEmail`, before the "keep current assignment" branch, add an eviction branch that fires when the email currently sits in a folder whose **own veto rules now reject it** — i.e. `emailVetoedForFolder(parsed, email.folder_id, context.filters)` is true (covers `domain_in` allowlists and `not_contains`/`not_equals` excludes). In that case, restore to the inbox using the exact steps the existing `inbox_override` branch and the bulk path use:

- set `folder_id = null`, `is_archived = false`, `matched_filter_ids = []`
- rebuild `raw_labels`: drop the folder's `gmail_label_id`, add `INBOX`
- call `modifyMessage(...)` to add `INBOX` and remove the folder label in Gmail (best-effort, logged on failure)
- persist the classification reason (e.g. "Removed from {folder} — sender excluded by folder rule")
- return `changed: true` with `folder_id: null` so the UI toasts "Re-analyzed → Inbox"

Keep the existing transient-failure guard: never evict on `classified_by === "ai_error"`.

Leave the genuine "AI simply found no better folder, but no rule forbids the current one" case untouched — that still returns `kept`, so a normal reanalyze of a correctly-filed email won't be cleared.

## Why this is safe

- The eviction is driven by deterministic folder rules (`emailVetoedForFolder`), not AI variance, so it can't be triggered by a flaky AI run.
- It reuses the already-proven inbox-restore steps (label rewrite + Gmail `modifyMessage`), so Gmail stays in sync and the next sync won't revert it — the same guarantee the bulk path relies on.
- Behavior now matches bulk Re-classify, removing the surprise of one "reprocess" button working and the other not.

## Verification

- Re-analyze the `sullivanlaw.com` email in GM Responses → it should return to the inbox, lose the GM Responses Gmail label, and toast "Re-analyzed → Inbox".
- Re-analyze an email correctly filed by an include filter (e.g. a real `RE: Daily Report`) → still "kept", no move.
- Run the existing filter-engine / reclassify tests, and add a unit test asserting `emailVetoedForFolder` is true for `sullivanlaw.com` against the GM Responses filter set.

## Files

- `src/lib/gmail.functions.ts` — add the deterministic-veto eviction branch to `reanalyzeEmail` (import `emailVetoedForFolder`, or reuse it via the classify context).
- Optionally a small test alongside the existing filter-engine tests.

## Note on the 236-email cleanup

Once this is fixed, the single-email Re-analyze becomes a reliable one-off tool, but the bulk Re-classify path already evicts these correctly — so for clearing all 236 external-domain emails, the bulk "Select all → Re-classify" rounds remain the faster route. This fix mainly removes the confusing per-email discrepancy you just hit.
