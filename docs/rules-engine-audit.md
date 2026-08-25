# Phase A — Rules engine audit

Deliverable for review. No engine code has been written. Everything below is measured against the live account data (199,228 emails, 29 folders, 210 rules) and the current source tree.

## 1. Every path that can set an email's folder

| # | Path | File | Order it applies | Writes through the single writer? |
|---|------|------|------------------|-----------------------------------|
| 1 | Arrival (push/poll job) | `sync/process-message.ts` | full ladder via `decideFolder` | yes (`persistDecision`) |
| 2 | AI second pass | `sync/classify.ts` | ladder rungs 7-8 after `decideFolder` | yes |
| 3 | Gmail label change | `sync/history.ts` (label mirror) | enters ladder as `label_change` | partially — patches `emails` directly at `history.ts:489` |
| 4 | Backfill / catch-up | `sync/catchup.ts`, `sync/backfill.ts` | rules only, own outcome builder | no — builds its own patch (`catchup.ts:132-171`) |
| 5 | Rescue pass | `sync/rescue.ts` | rules, then AI with its own confidence gate (`rescue.ts:300-310`) | no — separate patch shape |
| 6 | Reprocess / reanalyze | `gmail/reprocess.functions.ts` | own precedence, clears then refiles (`:85`, `:548`, `:634`, `:698`) | no |
| 7 | Rule actions / "apply rule now" | `gmail/rules.functions.ts` | direct folder + label writes (`:415`, `:457`, `:539`, `:630`, `:792`) | no |
| 8 | Domain move tooling | `gmail/domain.functions.ts` | bulk reassign by domain (`:134`, `:156`, `:199`) | no |
| 9 | Manual move / strip | `move-email.server.ts`, `gmail/move.functions.ts`, `gmail/folder-mgmt.functions.ts:344` | hard override | no |
| 10 | Scheduled actions | `sync/scheduled-actions.ts:240` | side-effect patch that can clear folder | no |
| 11 | Reconcile | `sync/reconcile.ts:141/184/237` | mirrors Gmail state, can strip folder | no |
| 12 | Classification feedback | `sync/classification-feedback.functions.ts:99` | user correction | no |

`decide-folder.ts` centralised precedence for paths 1-3 only. Nine of twelve paths still assemble their own patch, which is the concrete source of "same mailbox, different answer".

## 2. Where the orders disagree

- **Vetoes run after filing.** In `decide-folder.ts` the exclusion check lives inside the filter stage (rungs 2 and 5), so a folder that files at the label-mirror rung is only vetoed by *its own* exclusions; a global exclusion cannot pull a message back to the Inbox. This is exactly the ordering defect Amendment 1 fixes.
- **Hard rules are ordered by `folders.priority`** (`account-context.ts:104`, tiebreak text in `decide-folder.ts:378`). Two folders with generic rules and adjacent priorities produce order-dependent filing. Amendment 2 removes this input.
- **AI confidence gate is implemented twice** with different behaviour: `classify.ts` (folder `min_ai_confidence`) and `rescue.ts:302` (its own `threshold`, plus the extra `ai_low_confidence` state).
- **Reprocess re-derives from rules with `skipGmailLabelMatch`**, so a message filed by a Gmail label can silently change folder on reprocess.
- **Backfill and catch-up can run AI** today; Amendment 1 forbids that.
- **19 distinct `classified_by` values** exist in the data, including `gmail_search_ingest`, `global_exclude`, `manual_strip`, `manual_inbox`, `unclassified`, `pending`, `ai_error`. Several are written by only one path and have no ladder equivalent.

## 3. Decisions made but not recorded

- `decision_trace` is populated on **0 of 199,228** rows: only paths 1-3 write it, and no message has been through the new writer yet.
- Paths 4-12 record at most `classified_by` + `classification_reason` (encrypted), so the drawer cannot explain 80,000+ `none` rows or any bulk reassignment.
- `classification_feedback` has **0 rows** — corrections exist as manual moves (3,088 `manual_move`, 848 `manual_strip`, 22 `manual_inbox`) but carry no provenance flag distinguishing "user placed it" from "user confirmed it". Amendment 5's golden set and Amendment 4's protections both need that flag added.
- Side-effect skips (paused folder) are logged, not stored on the row.

## 4. Folder settings that silently interact

`priority`, `filter_logic`, `filter_tree`, `run_on_threads`, `skip_ai`, `ai_rule`, `min_ai_confidence`, `surface_ai_rule`, `is_cold_email`, `overrides_inbox_override`, `processing_enabled`, `auto_mark_read` + mark-read scope, `hide_from_inbox`, `gmail_label_id`.

Current live state: 29 folders — 16 paused, 18 `skip_ai`, 14 with an `ai_rule`, 2 `is_cold_email`, 0 with a `surface_ai_rule`. Plus 71 inbox overrides and 5 override exceptions.

Notable interactions:
- `overrides_inbox_override` lets a folder beat a global always-inbox rule, and can override the priority-sorted winner (`decide-folder.ts:344`) — two competing "who wins" mechanisms in one rung.
- `skip_ai` and an empty `ai_rule` both mean "no AI", set from different screens.
- `is_cold_email` + `calendarGuardEnabled` is a veto expressed as a folder flag, not as an exclusion — it belongs in Amendment 1 stage 1.
- 35,853 emails were filed by `inbox_override`, i.e. the guardrail stage is by far the highest-volume decision maker; putting it first is consistent with observed behaviour.

## 5. Existing rules mapped onto the specificity ladder

210 `folder_filters` rows, levels derived from the most specific condition:

| Level | Meaning | Rows |
|-------|---------|------|
| L1 exact sender | `from`, `origin_from` | 49 |
| L2 exact domain | `domain equals` / `domain_in` | 2 |
| L3 domain family | `domain contains` | 148 |
| L4 structural | `to`, `cc` | 2 |
| L5 content | `subject` contains/starts_with/equals | 5 |
| exclusions | `domain not_contains` | 4 |

Mapping notes: `domain contains` is the dominant authoring shape and maps to L3, not L2 — during migration, values that are a bare registrable domain should be offered an upgrade to L2 ("that domain only") because that is usually what the user meant.

### Same-level pairs targeting different folders (must be resolved)

Per account, real collisions today:

- user `06e3…60f`, **L1** `noreply@dealerimagepro.com` → Factory | Marketing | Notifications (3 folders)
- user `06e3…60f`, **L1** `noreply@reputation.com` → Factory | Notifications
- user `ad1c…f16c`, **L3** `app.medallia.com` → Factory | Notifications
- user `ad1c…f16c`, **L3** `mail3.veracross.com` → Notifications | School
- user `ad1c…f16c`, **L3** `parentsquare.com` → Notifications | School

Within the same account there are also duplicated same-level, same-folder rules (repeated OEM domains such as `ford.com`, `vw.com`, `nissan-usa.com`) — these are the merge case from Amendment 3, not blockers.

Today each of these resolves by `priority`, invisibly. Under the ladder they resolve by "older rule wins" plus a recorded collision event and a fix card, and the collision checker would have blocked the second save.

## 6. What Phase B has to change (consequences of this audit)

1. Move guardrails/exclusions and the calendar cold-email guard into stage 1, ahead of the label mirror.
2. Introduce pins as a first-class stage (today's inbox overrides become sender pins; `overrides_inbox_override` disappears).
3. Add thread continuity keyed on user-placed/confirmed decisions only — `run_on_threads` filter matching stays a rule condition, not a continuity source.
4. Replace priority ordering with the cached `specificity_level` + condition-count + `created_at` resolver.
5. Collapse the two AI confidence gates into one and delete the AI stage from backfill, catch-up, rescue and reprocess.
6. Route paths 4-12 through `persistDecision` so every write carries a trace and provenance.
7. Add provenance columns (`placed_by_user`, `decision_confirmed_at`) before the golden set can be built, since `classification_feedback` is empty.

Reviewed and approved by you, this becomes the Phase B work order.
