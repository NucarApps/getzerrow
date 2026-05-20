## Problem

Gmail returns message snippets HTML-encoded (e.g. `I&#39;m`, `&amp;`, `&quot;`). The inbox list renders these raw, so users see literal `&#39;` instead of `'`.

## Fix

Add a small `decodeHtmlEntities(str)` helper and apply it when rendering text fields that originate from Gmail's API in the inbox list.

### Changes (frontend only)

**`src/routes/_authenticated/inbox.tsx`**
- Add a local `decodeHtmlEntities` helper that handles named entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&nbsp;`) and numeric entities (`&#39;`, `&#x27;`). Pure string transform, SSR-safe (no DOM).
- Apply it when rendering:
  - `e.snippet`
  - `e.subject`
  - `e.from_name` / sender display
  - `e.ai_summary` (in case the model echoes encoded text)
- Also apply inside the search filter so queries match the decoded text.

## Out of scope

- No DB migration / backfill — decoding happens at render time, so old and new rows both display correctly.
- No changes to how snippets are stored or to the Gmail sync pipeline.
- No changes to the reading pane (separate pass if needed).
