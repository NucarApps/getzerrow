# Phase E — switching the live pipeline to the amended engine

## What runs where

`classifyParsedEmail` (src/lib/sync/classify.ts) now has three stages:

1. `classifyByRules` — the legacy `decideFolder` ladder (unchanged).
2. `runEngineStage` (src/lib/sync/engine-stage.ts) — the amended engine
   from `src/lib/rules`, via the bridge.
3. the async AI passes — unchanged, driven by `needs_ai` /
   `needs_surface_check` whichever engine produced them.

## The switch

`RULES_ENGINE_V2` is read per request (`src/lib/rules/mode.server.ts`):

| value | behaviour |
| --- | --- |
| `off` | legacy only. No engine run, no logs. |
| unset / `shadow` | **default.** Legacy decides. The engine runs alongside; every disagreement and collision is logged. Zero behaviour change. |
| `on` | The engine decides the deterministic stages. Its v2 trace is stored on the email. |

Rollback is a variable change, not a deploy of old code.

## What to watch in shadow mode

- `rules_engine.compare` (metric) — `agree` true/false per message, with
  `engine_stage` and `legacy_classified_by`.
- `rules_engine.disagreement` — folder ids and stage names only, never
  content. Read this before flipping to `on`.
- `rules_engine.collision` — two same-level rules claiming one message for
  different folders. Should trend to zero once Phase D's save-time checker
  has been in front of users for a while.
- `rules_engine.failed` — the engine threw; the legacy answer was used.
  Should be empty.

## Bridge: the three legacy escapes

`src/lib/rules/bridge.ts` maps `AccountContext` onto the engine's inputs.
Beyond the plain adapters it handles:

- **override exceptions** — an always-inbox override with a matching
  exception is not a pin at all, so it never reaches stage 2.
- **`overrides_inbox_override`** — when a folder allowed to beat the inbox
  list has a matching rule, the pin is dropped so the rule stage can win.
- **sender groups** — resolved onto the message so `sender_in_group`
  conditions evaluate with no extra round trip.

Deliberately NOT carried over: the calendar cold-email guard, which the
amendments replace with explicit guardrails. Expect shadow disagreements on
cold mail while the guard is still configured.

## Golden set

`src/lib/rules/golden-dataset.ts` holds labelled cases over a small
synthetic mailbox; `runGolden` scores them with the AI stage off and
`golden.test.ts` requires 100%. A case asserts BOTH the folder and the
deciding stage, so reaching the right folder through the wrong stage still
fails — that is a precedence change and needs to be argued for in the diff.

Adding a case is cheap. Changing an expectation is a deliberate act.
