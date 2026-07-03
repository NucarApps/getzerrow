# Fix: "internal domains only" folders must hard-block external senders

## Why the chat fix didn't stick

Laura Steinberg (`lsteinberg@sullivanlaw.com`) was filed into **GM Responses** by the **AI classifier** (`classified_by = ai`, confidence **1.0**) — not by a rule.

Your chat edit turned "only internal domains" into **soft AI guidance**: it rewrote the folder's `ai_rule` and `learned_profile` ("STRICTLY INTERNAL ONLY… exclude sullivanlaw.com…") and set `min_ai_confidence` to 0.99. Those are hints the model can ignore — and it did, returning 1.0 confidence, which passes the 0.99 gate. Nothing deterministically stops an external sender.

Root cause: the folder chat can only create *include* filters (`contains` / `equals` / `starts_with`). It has no way to create a hard exclusion or an allowlist, so every "exclude" request degrades into fuzzy AI text.

## What I'll build

### 1. A deterministic "internal domains" allowlist (the guarantee)
Add a new filter operator, **`domain_in`**, whose value is a comma-separated domain allowlist (e.g. `dcd.auto,nucar.com,nucarpulse.com,intervaleproperties.com`). It acts as a **veto**: if the sender's domain is not in the list, the folder is hard-blocked — before the AI classifier ever runs. This automatically catches any future external domain, not just the law firms you named.

Plus the named exclusions you asked for as an extra layer: hard `not_contains` rules on `domain` for `sullivanlaw.com`, `ycst.com`, `bakertilly.com`, `clerq.io`.

### 2. Upgrade the folder chat to create hard rules
Teach the chat's `add_filter` action to emit the exclusion operators (`domain_in` allowlist, plus `not_contains` / `not_equals`), and steer the model to prefer a deterministic rule over AI-text guidance whenever the user asks to include/exclude by sender or domain. Result: next time you say "only our internal domains," it becomes an enforced filter, not a hint.

### 3. Apply it to GM Responses and reprocess
Add the allowlist + named exclusions to the GM Responses folder now, then re-run classification on the affected emails so Laura's message (and any other external-domain mail) leaves the folder immediately.

## Technical details

- **`src/lib/sync/filter-engine.ts`**
  - `applyFilter`: add `domain_in` — split `value` on commas, trim, and match the sender domain against the set. (`domain` field already resolves to `from_addr`'s domain.)
  - Exclude/veto handling: generalize the veto so `domain_in` vetoes when the domain is *not* in the list (currently the veto only understands `not_contains`/`not_equals`). Add `domain_in` to the exclude-op set with its own "veto when predicate fails" semantics.
  - Keep the module pure (no Supabase imports), per project rules.
  - Extend `filter-engine.test.ts`: allowlist veto blocks external domains, admits internal ones, and produces a `kind: "excluded"` result (which sets `aiSkipped`, so AI never runs).

- **`src/lib/folder-chat.server.ts`** — extend the `add_filter` op enum to include `domain_in`, `not_contains`, `not_equals`; document them in the prompt and instruct the model to prefer a deterministic filter for domain/sender include-or-exclude requests instead of `update_folder_rule`/`update_folder_profile`.

- **`src/lib/folder-chat.functions.ts`** — mirror the op enum in `actionInputSchema`; normalize `domain_in` values (lowercase, strip `@`, dedupe) on insert.

- **`src/components/folders/FolderEditor.tsx`** / **`FolderChatPanel.tsx`** — add `domain_in` ("sender domain is one of") to the operator picker and render it in proposed-change previews, so the same rule is visible and editable in the manual UI.

- **Data change (GM Responses)** — insert one `domain_in` filter with the four internal domains, plus `not_contains` filters for the four external domains. Optionally relax `min_ai_confidence` back from 0.99 (the allowlist is now the real guard) — I'll confirm the value with you before changing it.

- **Reprocess** — invoke the existing `reclassifyEmails` path for GM Responses so already-misfiled external mail is re-evaluated against the new deterministic rule and removed from the folder.

## Scope notes
- The allowlist keys on the **sender** domain (deterministic and reliable). Recipient-based "all To/Cc must be internal" is fuzzier and out of scope unless you want it.
- No new tables; `folder_filters` has no op CHECK constraint, so the new operator needs no migration — only app-layer validation.
