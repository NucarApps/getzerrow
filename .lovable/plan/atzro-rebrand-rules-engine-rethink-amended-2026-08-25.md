# Atzro rebrand + rules engine rethink (amended)

Workstream 1 (rebrand) is unchanged and already shipped. Workstream 2 is replaced below by the amended design. Where this text disagrees with the original plan, this text wins.

Protected and untouched by this workstream: CardDAV endpoint, contacts engine, Google Contacts sync, Inbox and All Mail views, meetings, and all of their tables and routes. Database and environment variable names stay as they are.

## The pipeline (Amendment 1)

Evaluated once per message by a single `evaluate()`; first decision wins; no other code path may file mail.

```text
1. Guardrails and exclusions  security codes, 2FA, protected senders, any
                              matching exclusion -> pin to Inbox, stop
2. Pins                       explicit per-sender / per-thread user pins
                              (always-inbox or always-folder) -> stop
3. Gmail label mirror         folder linked to a label Gmail already applied
4. Thread continuity          earlier message in the thread was filed by a user
                              action or a confirmed decision -> same folder.
                              Never chains off an unconfirmed AI decision.
5. Hard rules                 specificity ladder (Amendment 2)
6. AI fallback                only if stage 5 returned nothing: score against
                              every eligible folder's description + learned
                              profile, file the best above that folder's
                              confidence floor, else abstain
7. Inbox                      nothing matched, mail stays put
```

Backfill, reprocess, and replay call the same `evaluate()` with the AI stage disabled. Existing AI placements stand unless a rule now claims the message.

## Specificity ladder (Amendment 2)

No manual rule or folder ordering for filing anywhere: no priority numbers, no drag-to-reorder. When several rules match, the most specific wins.

- L1 exact sender (`billing@netflix.com`)
- L2 exact domain (`@amazon.com`, that domain only)
- L3 domain family (`amazon.com` including subdomains)
- L4 structural (List-Id, to/cc, has-attachment)
- L5 content (subject/body contains, patterns)

Ties inside a level: more conditions wins, then the older rule wins. Fully deterministic. A rule's level is derived from its most specific condition and cached on the row.

## Collision prevention at save time (Amendment 3)

On create or edit, before the rule saves, its conditions run against the trailing 90 days of mail and against every rule at the same level.

- Same level, same folder: propose merging values/conditions into the existing rule instead of creating a duplicate.
- Same level, different folder: block the save. Show the conflicting rule and the actual overlapping messages, with one-tap fixes — add a suggested exception to the draft, narrow the existing rule, or reassign. An unresolved conflict cannot be saved.
- Cross-level overlap: informational only; the ladder decides it.

Runtime defense: if a live message still matches two same-level rules with different folders, the older rule wins, a collision event is recorded, and a card asks you to add an exception. Never silent.

## Replay with change-sets (Amendment 4)

Every rule create, edit, or disable replays the trailing 90 days (rules stages only). Output is a change-set you review, never an automatic reshuffle.

- Summary line ("affects 14: 12 Inbox to Receipts, 2 Shipping to Receipts"), item list grouped from-folder to-folder, Apply All / Apply Selected / Dismiss.
- Protections: hand-placed messages never move. Moves out of a folder where you previously confirmed the placement are flagged requires-review and excluded from Apply All.
- The same machinery powers the editor's debounced live preview: match count, five samples, inline collision warnings.

## Golden dataset and scorecard (Amendment 5)

Gate on the switch flip for an account:

- Golden set built from every message whose correct folder is known (your corrections and confirmed placements), each with provenance.
- A page that replays the golden set through the new engine: overall accuracy, per-folder precision and recall, drill-in on misses with each miss's trace.
- The new engine must beat the current system's post-correction accuracy there. The per-account switch stays as the live comparison period.

## Visible learning and promotion (Amendment 6)

Every correction produces an artifact in decision history: example added to folder X, rule created or merged, description edit proposed as an Apply/Dismiss diff. Corrections also write a negative signal to the losing folder's learned profile. When the AI files the same sender or domain to the same folder three or more times with no corrections, a promotion suggestion appears; one tap converts it to a hard rule, which then passes the collision checker like any other rule.

## Trace and editor UI (Amendment 7)

Trace as previously planned, plus: for the rules stage, record all matching rules with their ladder levels and why the winner won, and up to 10 evaluated-but-failed rules with per-condition pass/fail.

Editor: rules render as plain sentences with literal values as chips and a specificity badge ("L2 exact domain"). Editing is inline chip add/remove with a type-ahead that parses input (contains `@` offers "sender is", otherwise "domain is" / "subject contains"). OR-of-ANDs machinery stays hidden until a second match group is added. Interaction patterns follow your reference mockup; visuals adapt to Atzro's design system.

## Phase order

- **Phase A — audit.** Map every path that can set a folder, where their orders disagree, decisions made but not recorded, and silently interacting folder settings. Added by amendment: map every existing rule onto the ladder and flag same-level pairs targeting different folders. The audit document comes to you for review before any engine code is written.
- **Phase B — engine.** `evaluate()` in the amended order, ladder resolution, guardrails, pins, thread continuity, AI stage.
- **Phase C — trace + decision history** with the amended rules detail.
- **Phase D — save-time collision checker, replay change-sets, live preview.**
- **Phase E — golden set + scorecard**, then the per-account switch and flip.

## Technical notes

- Pure module `src/lib/rules/` exporting `evaluate(message, context, opts)` -> `{ folderId, stage, trace }`, no Supabase imports. The ladder resolver, guardrail set, and collision checker are separate pure units with table-driven tests.
- The current `decide-folder.ts` ladder already centralizes precedence but orders hard rules by folder `priority` and runs vetoes inside the filter stage. It is reworked to the amended order, and `priority` stops influencing filing (column retained, ignored, then dropped from the UI).
- New columns: rules gain a cached `specificity_level` and `created_at` tiebreak; folders gain `description`; emails gain `decision_confirmed_at` / `placed_by_user` provenance (the `decision_trace` jsonb column already exists). Pins, collision events, replay change-sets, and golden-set entries each get a table with owner-scoped access rules.
- Replay and golden-set scoring run as server functions in chunks with a wall-clock budget, matching the existing enrichment batch pattern.
- No AI calls in replay, backfill, or reprocess paths.

Please attach the reference mockup file before Phase D UI work; Phase A can start immediately.
