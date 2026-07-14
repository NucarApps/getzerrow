# Split the two monolith files

`inbox.tsx` (3,096 lines) and `FolderEditor.tsx` (2,236 lines) are the last piece of the earlier cleanup we deferred. This is a **pure extraction refactor** — no behavior, styling, or data-flow changes. Every extracted piece keeps its current props and logic; we only move code into smaller files and import it back.

## Goal

- Cut each monolith down to a readable core (target ~900–1,100 lines each).
- Make each tab / panel independently editable without scrolling a 3,000-line file.
- Zero user-visible change — verified by typecheck, lint, tests, and a browser smoke test of the inbox and folder editor.

## FolderEditor.tsx — extract self-contained helpers

These are already top-level functions taking props, with no closure over the editor's internals. Move each into its own file under a new `src/components/folders/editor/` directory:

```text
src/components/folders/editor/
  folder-history-panel.tsx   <- HistoryPanel + ReasonBlock + matchFilter + RulePatchCard + getReasonMeta + relativeTime
  folder-summaries-panel.tsx <- SummariesPanel + pad2
  folder-schedule-form.tsx   <- ScheduleForm
  folder-rule-group-editor.tsx <- RuleGroupEditor
  folder-scan-gmail-section.tsx <- ScanGmailSection
```

`FolderEditor.tsx` keeps the core component (header, tab wiring, mutation handlers) and imports these five back. Shared types (`Filter`, `HistoryEmail`, etc.) move to a small `src/components/folders/editor/types.ts` if they're referenced across files. This alone drops `FolderEditor.tsx` to roughly ~900 lines.

Optional second pass (only if the core is still unwieldy): lift each `TabsContent` body (Rules / AI / Automation) into `rules-tab.tsx`, `ai-tab.tsx`, `automation-tab.tsx`, receiving the `local`/`dirty`/`save`/handlers as props. History and Chat tabs already delegate to external components.

## inbox.tsx — extract render-only + leaf components

`InboxPage` holds the state (queries, `selectedIds`, pagination, realtime effects) and that stays put. We extract the presentational and leaf pieces that already stand alone:

```text
src/components/emails/
  email-body-frame.tsx    <- EmailBodyFrame + EmailBodyInline + hasVisibleHtml
  swipe-row.tsx           <- SwipeRow
  triggered-by.tsx        <- TriggeredBy + the "Why this folder?" reason rendering block
src/lib/
  email-text.ts           <- decodeEntities + NAMED_ENTITIES + errMsg + parseSearchQuery + withInbox/withoutInbox helpers (pure utils)
```

The email-row JSX is currently inline inside `InboxPage`'s map and closes over a lot of handlers; extracting a full `EmailRow` is higher-risk, so it's **out of scope for this pass** unless the core file is still too large afterward. This keeps the refactor low-risk while still moving ~600–800 lines out.

## Constraints / safety

- No logic changes: cut-and-paste bodies verbatim, fix imports only.
- Follow workspace conventions: kebab-case filenames, named exports (no default exports), PascalCase components.
- Do the two files in separate edit batches so a failure in one doesn't obscure the other.

## Verification

1. `tsgo` typecheck clean.
2. Lint clean, no unused imports left behind in the source files.
3. Run the existing test suite.
4. Browser smoke test via Playwright: open `/inbox` (list renders, select an email, open "Why this folder?", multi-select bar appears) and open a folder in the editor (each tab renders). Screenshot both.

## Out of scope

- Full `EmailRow` extraction from the inbox map.
- Any change to server functions, queries, schema, styling, or the `useScopedAccount` work already shipped.
