# Rules engine: one decision, one path

The audit found nine different places in the code that can decide which folder an email lands in. Only one of them (the live arrival path) actually follows the full set of rules you configured. The others each implement a partial copy — which is why filing feels inconsistent and why "why did this land here?" often has no good answer.

## What's broken today

- **Gmail label sync ignores everything.** When a label appears on a message (from your phone, another client, or a paused folder's label), the email is moved into that folder with no check of your always-inbox overrides, no exclusion rules, no domain allowlists, and no calendar cold-email guard. Paused folders still get mail this way.
- **Backfill and "scan Gmail" use a weaker engine.** No overrides, no AI, no cold-email guard, no surface-to-inbox.
- **Manual moves and rule actions rewrite the folder without updating the explanation.** After a "move to folder" action fires, the stored reason still describes the *original* decision, so the AI-decision drawer shows something provably wrong.
- **The confidence threshold exists in three hand-copied versions** (live, rescue batch, reanalyze) that can drift apart.
- **Rescue skips surface-to-inbox**, so mail that was stranded and later rescued never gets pulled back to your inbox even when the folder says it should.
- **Most paths write no audit row at all.** Manual moves, bulk moves, label claims, backfill and reanalyze never record to the rules-activity log, so the log only shows a fraction of what happened.
- **Losing candidates are never recorded.** When three folders matched and priority picked one, the other two are computed and thrown away — so we can't explain the choice.

## The rebuild

### 1. One decision function

Create a single pure `decideFolder()` that is the only thing allowed to produce a filing decision. Inputs: the email, the folder set, filters, overrides, exceptions, sender groups, calendar contacts, thread context, and the trigger (`arrival`, `label_change`, `backfill`, `rescue`, `reanalyze`, `manual`). Output: chosen folder, a `classified_by` value, a human reason, and a full **decision trace** (every folder considered, every rule that matched, every veto that fired, and why the winner won).

Fixed precedence, applied identically for every trigger:

```text
1. folder paused            -> inert, never a destination
2. exclusion / domain_in veto -> folder disqualified
3. always-inbox override    -> inbox, unless folder opts out
4. linked Gmail label       -> that folder
5. filter tree / filters    -> highest-priority surviving folder
6. calendar cold-email guard -> inbox
7. AI (only if ai_rule set, not skip_ai, above min confidence)
8. surface-to-inbox rule    -> keep visible in inbox, still filed
9. no match                 -> inbox
```

Manual moves stay an intentional hard override, but they now go through the same function so they record a trace and respect pause.

### 2. Every path calls it

Rewrite all nine writers to call `decideFolder()` and then one shared `applyDecision()` that persists folder, classifier, reason, trace, side effects (archive / mark-read scope / star / hide / snooze / forward) and the audit row. No path gets to set `folder_id` directly anymore — enforced by a lint-style test that fails if `folder_id` is written outside `applyDecision`.

This closes: label-mirror bypass, paused folders receiving mail, backfill weakness, missing side effects on manual moves, stale reasons after rule actions.

### 3. Full explainability

Persist the decision trace with each email and render it in the AI-decision drawer: candidates considered, rules matched per candidate, vetoes, the AI confidence vs. your threshold, and the tiebreak. Every path writes an activity-log row, including manual moves and backfill.

### 4. Rule simulator

Given a folder's current rules, show live which of your recent messages would land there, which would be vetoed, and which the AI would have to judge — before you save.

### 5. Verification

Table-driven tests for the precedence ladder (one case per rung, per trigger), plus regression tests for each bug named above: paused folder + Gmail label, override vs. label, excluded domain via manual move, rescue + surface rule, rule action reason freshness.

## Technical notes

- `src/lib/sync/decide-folder.ts` (new, pure, no Supabase) absorbs `classify.ts` precedence, `ingest-classify.ts`, and `filter-engine.ts` matching; `filter-engine.ts` stays as the leaf matcher.
- `src/lib/sync/apply-decision.ts` (new) is the single writer: emails patch + `executed_rules` + `computeFolderEffects` + Gmail label sync.
- Rewritten callers: `process-message.ts`, `rescue.ts`, `history.ts` (`applyLabelChange`), `gmail/ingest-classify.ts` callers (`reprocess.functions.ts`, `rules.functions.ts`), `folder-learn.ts`, `move-email.server.ts`, `move.functions.ts` (`reanalyzeEmail`, `reclassifyEmails`, `bulkMoveEmails`), `action-dispatch.ts`.
- New column `emails.decision_trace jsonb` plus `executed_rules.trace_json`, both encrypted-at-rest consistent with existing columns.
- Deleted: the duplicated `min_ai_confidence` gate in `rescue.ts`, the ad-hoc override/exclusion branches in `move.functions.ts`.

Existing filed mail is not re-filed by this change; the new engine applies to new arrivals and to anything you explicitly reanalyze.
