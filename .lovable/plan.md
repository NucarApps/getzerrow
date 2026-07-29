## Goal

Today "Auto mark-read" on a folder is all-or-nothing: every email routed into the folder gets marked read. You want to keep some senders or domains unread while everything else is auto-read (or the reverse — only auto-read a few senders/domains).

## What you'll get

In the folder editor, under Automation, "Auto mark-read" gains a mode when it's on:

- **Everything** (current behavior)
- **Everything except…** — keeps listed senders/domains unread
- **Only these…** — auto-reads only listed senders/domains, everything else stays unread

Below the mode is a small list editor where you add entries, each either a full address (`jared@kenect.com`) or a domain (`kenect.com`). Mixing both in one list is fine, so "mark all read except two people and one domain" is one list.

Behavior notes:
- Matching uses the same sender the rules use, including the original sender of auto-forwarded mail, so a forwarded message is judged by who really sent it.
- The scope applies to newly routed mail and to catch-up/backfill processing, consistently.
- Only mark-read is scoped in this change; auto-archive, star, and hide-from-inbox keep their current all-or-nothing behavior. Same pattern can be extended to them later if you want.

## Technical plan

**Database (one migration)**
- `folders.mark_read_mode text not null default 'all'` with a check constraint on `('all','except','only')`.
- New table `public.folder_mark_read_rules` (`id`, `user_id`, `folder_id` FK → folders on delete cascade, `match_type` in `('email','domain')`, `value text`, timestamps, unique on `(folder_id, match_type, value)`), plus GRANTs to `authenticated`/`service_role`, RLS enabled, owner-scoped policy on `auth.uid() = user_id`, and an `updated_at` trigger.

**Pure logic**
- New `src/lib/sync/mark-read-scope.ts`: `resolveAutoMarkRead(folder, rules, sender)` returning a boolean, where `sender` is the effective sender (`origin_addr ?? from_addr`). Domain matching reuses `emailDomain`. Unit tests cover all three modes, mixed email+domain lists, forwarded mail, and empty lists (`except` with no entries = mark all, `only` with no entries = mark none).

**Wiring (single choke point)**
- `ActionFolder` in `src/lib/sync/process-message.ts` keeps its `auto_mark_read: boolean`, but the two builders (`resolveFolderFromContext` and `fetchActionFolder`) now resolve it through `resolveAutoMarkRead` using the message's sender. `computeFolderEffects`, `mergeFlagActions` (synthetic `mark_read`), the insert's `isReadFlag`, and `src/lib/sync/catchup.ts` then need no changes — they all read that one field.
- `AccountContext` (`src/lib/sync/account-context.ts`) loads `mark_read_mode` and the folder's rule rows alongside folders/filters, so the hot path stays cache-backed; folder-rule writes call the existing account-context invalidation.
- `src/lib/sync/run-jobs.ts` and `src/lib/sync/simulate-rule.functions.ts` pass the sender through the same resolver so the rule simulator preview matches real behavior.

**Server functions**
- Add `listFolderMarkReadRules`, `addFolderMarkReadRule`, `removeFolderMarkReadRule` to the folder-management server functions (auth middleware, folder ownership check, value normalization: trim, lowercase, strip a leading `@`), each invalidating the account context.

**UI**
- `src/components/folders/FolderEditor.tsx`: when Auto mark-read is on, render the three-way mode selector and the entry list (add input + chips with remove), styled like the existing inbox-overrides list. Entry type (email vs domain) is inferred from whether the value contains `@`.
- `src/components/folders/editor/types.ts` and `src/lib/sync/types.ts` gain `mark_read_mode`; the folder select strings are updated to fetch it.

**Verification**
- New unit tests for `mark-read-scope.ts`, plus updates to existing process-message/catchup fixtures for the new folder field; full typecheck and test run before finishing.
