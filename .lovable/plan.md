# Code review — keep-it-clean plan

Overall the codebase is in good shape: strict TS, no `any`, no `console.log`, no TODO/FIXME litter, consistent kebab-case + named exports, real test coverage on the sync core, and the earlier `.lovable/plan.md` extraction pass already trimmed the two worst monoliths. The remaining issues are all "a few files have quietly become god-modules." Below is what to tackle next, ordered by pain-relief per hour. Every item is a pure organization refactor — no behavior, styling, or data-flow changes.

## What the review found

Large-file inventory (lines):

```text
4355  src/lib/gmail.functions.ts          <- 68 server fns in one file
2558  src/routes/_authenticated/inbox.tsx
1621  src/routes/_authenticated/meetings.tsx
1467  src/lib/sync.server.ts
1337  src/routes/_authenticated/contacts.index.tsx
1319  src/lib/contacts.functions.ts       (15 server fns)
1210  src/lib/invader/useInvaderGame.ts
1173  src/components/settings/PubsubActivity.tsx
1115  src/lib/meetings.functions.ts       (32 server fns)
1074  src/components/folders/FolderEditor.tsx
 943  src/lib/ai.server.ts
```

(`types.ts` and `routeTree.gen.ts` are generated — ignore.)

Everything else is under ~800 lines and fine.

## Priority 1 — split `gmail.functions.ts` (biggest single win)

4,355 lines / 68 `createServerFn`s in one module is the number-one readability problem. The exports already cluster into clear domains — split along those seams into siblings that keep the same public API (re-export from `gmail.functions.ts` as a barrel for one release so nothing else has to change).

```text
src/lib/gmail/
  accounts.functions.ts     list/start/connect/disconnect/renewWatch
  labels.functions.ts       listGmailLabels, createGmailLabel, learn/apply label
  backfill.functions.ts     trigger*/startDeep/getStatus/cancelDeep/loadOlder
  sync.functions.ts         triggerSync, backgroundSync, syncMyReadState
  message-actions.functions.ts  markEmailRead, archive, trash, generate/sendReply
  folder-domain.functions.ts    listFolderDomainSuggestions, addDomainFilter, reassignDomainToFolder, scanGmailForFolder
  folder-health.functions.ts    getFolderHealth, listFolderHistory, relearn, suggestRecategorization, applyRecategorization
  folder-summaries.functions.ts list/create/update/delete/run*/get
  folder-ai.functions.ts        generateFolderAiRule*, learnFolderFromLabel
src/lib/gmail.functions.ts       barrel: `export * from "./gmail/…"`
```

Target: no single file over ~700 lines. Pure cut-and-paste; imports of the existing top-level names keep working through the barrel.

## Priority 2 — same treatment for the other two `*.functions.ts` giants

- `src/lib/contacts.functions.ts` (1319 / 15 fns) → `src/lib/contacts/{contacts,companies,notes,merge}.functions.ts` (exact buckets to be decided by the actual exports at split time).
- `src/lib/meetings.functions.ts` (1115 / 32 fns) → `src/lib/meetings/{settings,recording,transcript,summary,bot,calendar}.functions.ts`.

Same barrel pattern.

## Priority 3 — finish the route-file extractions the `.lovable/plan.md` explicitly deferred

The extraction pass shipped presentational leaves but consciously punted on the biggest wins. Do them now that the leaves are stable:

- **`inbox.tsx` (2558)** — extract the `EmailRow` (the inline row inside the list `.map`) into `src/components/emails/email-row.tsx`, taking handlers as props. This is the single change that drops the file most. Also lift the search/filter toolbar into `src/components/inbox/inbox-toolbar.tsx`.
- **`FolderEditor.tsx` (1074)** — lift each remaining `TabsContent` body (Rules / AI / Automation) into `src/components/folders/editor/{rules-tab,ai-tab,automation-tab}.tsx`, receiving `local`/`dirty`/`save`/handlers as props. History / Chat / Summaries / Schedule / ScanGmail / RuleGroup already live outside; this closes out the plan.
- **`meetings.tsx` (1621)** and **`contacts.index.tsx` (1337)** — same recipe: keep the `Route` + top-level state/query wiring, lift each panel/section into `src/components/meetings/*` and `src/components/contacts/*`. Aim for ~600–800 lines in the route file.

## Priority 4 — split `sync.server.ts` (1467)

`src/lib/sync/` already exists and holds the modular pieces (`process-message`, `classify`, `filter-engine`, `reconcile`, `dlq`, …). `sync.server.ts` at 1.4k lines is the last remaining "everything else" bucket. Move each logical chunk into a same-named file under `src/lib/sync/` and keep `sync.server.ts` as a thin re-export while call sites migrate. This preserves the "filter engine is pure, no supabase imports" rule already in project knowledge.

## Priority 5 — smaller organization nits

- `src/components/settings/PubsubActivity.tsx` (1173) — split the drawer, table, and stats card into siblings under `src/components/settings/pubsub/`.
- `src/lib/invader/useInvaderGame.ts` (1210) — move the pure engine reducers and constants into `src/lib/invader/engine.ts` (already exists) or `src/lib/invader/reducers.ts`; the hook should just wire React state to the engine.
- `src/lib/ai.server.ts` (943) — group by capability (`classify`, `summarize`, `draft`, `learn`) under `src/lib/ai/`. Same barrel.
- Add one shared `useAiDecisionDrawer(email)` hook if the new drawer starts getting reused outside `inbox.tsx` — not needed yet, just flagging.

## Not doing / out of scope

- No behavior, styling, data-flow, schema, RLS, or query changes.
- No changes to auto-generated files (`routeTree.gen.ts`, `integrations/supabase/*`).
- No default-export migrations — the codebase is already all named exports.
- No lint/format rule changes — current config is fine and being followed.
- No dependency upgrades.

## Suggested rollout

One PR per priority, in order 1 → 5, each independently verifiable with:

1. `tsgo` typecheck clean.
2. Lint clean, no unused imports left behind.
3. Existing test suite green (sync tests are the safety net for P4).
4. Playwright smoke: `/inbox` renders + row interactions, folder editor tabs render, `/meetings`, `/contacts` render.

Priorities 1–3 are the ones I'd actually schedule now; 4–5 are "next time you're in the file." Want me to start with Priority 1 (the `gmail.functions.ts` split)?
