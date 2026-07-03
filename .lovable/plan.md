# Folder AI "surface to inbox" escape hatch

## Goal
Let a folder file mail by rules as usual, but give the AI a plain-English instruction to *pull back* specific matching emails so they stay visible in your inbox. Example: a Factory folder swallows everything from the factory, except an email that's addressed specifically to you and mentions your name — that one surfaces to the inbox while still being filed into Factory.

Based on your choices:
- Surfaced mail is **filed into the folder AND kept visible in the inbox** (not hidden/archived).
- The exception is a **natural-language AI rule** per folder.
- Identity matching uses your **connected Gmail address** plus any **names/aliases you type** for that folder.

## How it behaves
```text
incoming email
   │
   ▼
deterministic rules match folder "Factory"
   │
   ├─ folder has no surface rule ──► file normally (hide/archive per settings)
   │
   └─ folder has a surface rule ──► AI checks the rule against this email
             │                        (uses to/cc, body, your identity)
             ├─ "surface = yes" ──► label into Factory, KEEP in inbox, tag as surfaced
             └─ "surface = no"  ──► file normally (hide/archive per settings)
```
Only folders that actually have a surface rule pay for an AI call, and only for mail the rules already routed there. Folders without a surface rule are unchanged.

## What you'll configure (folder settings)
A new "Surface to inbox (AI)" block, shown near the existing "Rules only" toggle:
- A textarea: *"Keep in my inbox when… e.g. it's addressed specifically to me and mentions my name, or it needs my personal reply."*
- An optional names/aliases field (comma-separated) added on top of your connected Gmail address.
- Empty rule = feature off for that folder (default).

Surfaced emails appear in the inbox with a "Surfaced" tag and a short reason ("addressed directly to you") so it's clear why they weren't tucked away.

## Scope notes
- Applies to newly arriving mail and to reanalyze/reclassify runs.
- Retroactively re-scanning old already-filed mail is not included in this pass (can be a follow-up).

---

## Technical details

### 1. Database migration (`folders` + `emails`)
- `folders.surface_ai_rule text` (nullable) — natural-language surface rule; empty/null disables.
- `folders.surface_names text` (nullable) — extra names/aliases for identity matching.
- `emails.surfaced_to_inbox boolean not null default false` — marks a rule-filed email that the AI forced back to the inbox.
- No new tables, so no new GRANT/RLS blocks; existing `folders`/`emails` policies already cover the columns. Regenerate types after approval.

### 2. Account context (`src/lib/sync/account-context.ts`)
- Add `email_address` to the `gmail_accounts` select and expose `accountEmail: string | null` on `AccountContext` (needed as the identity for the surface check). Folders already load via `select("*")`, so the two new folder columns come through automatically.

### 3. Types (`src/lib/sync/types.ts` + `FolderEditor` Folder type)
- Add `surface_ai_rule: string | null` and `surface_names: string | null` to the `Folder` type in both places.

### 4. AI surface decision (`src/lib/ai.server.ts`)
- New `shouldSurfaceToInbox(email, opts)` using the same structured-output/fallback pattern as `classifyEmail`. Inputs: `from`, `to_addrs`, `cc`, `subject`, `body`, plus `{ folderName, surfaceRule, identityEmails, identityNames }`. Returns `{ surface: boolean, reason: string }`. Prompt frames it as: "Given the user's surface rule and identity, should this folder-filed email stay visible in the inbox?"

### 5. Classification wiring (`src/lib/sync/classify.ts`)
- Extend `RulesClassification` with `needs_surface_check: boolean` — true when rules matched a folder (`filter`/`domain_rule`/`gmail_label`) whose `surface_ai_rule` is non-empty. Keeps `classifyByRules` pure (just reads the folder field).
- Add async helper `applySurfaceRule(parsed, context, base)` that calls `shouldSurfaceToInbox`, and returns the base result annotated with a `surfaced` flag + reason.

### 6. Pipeline (`src/lib/sync/process-message.ts`)
- When `needs_surface_check` is true, insert the email **visible** (don't pre-apply archive/hide effects), then run `applySurfaceRule`:
  - **surface = yes:** add the folder's Gmail label + star only if configured, but skip `hide_from_inbox`/`auto_archive`; set `surfaced_to_inbox = true`, `is_archived = false`, `classified_by = "surfaced_to_inbox"`, and a reason. Folder_id stays set.
  - **surface = no:** run the normal `applyFolderActions(..., persistFlags: true)` path (existing behavior).
- Reuse this in the existing reclassify branch so reanalyze respects the rule.

### 7. Inbox visibility (`src/lib/search-scope.ts` + `search-scope.test.ts`)
- `emailBelongsInScope` for the main inbox (`"all"`) currently hides mail whose folder has `auto_archive`/`hide_from_inbox`. Add: an email with `surfaced_to_inbox === true` bypasses that folder-flag check (still requires the `INBOX` label and `is_archived !== true`). Add `surfaced_to_inbox?: boolean` to `ScopeEmail` and cover it with tests.
- Ensure the inbox email query selects `surfaced_to_inbox`.

### 8. Folder editor UI (`src/components/folders/FolderEditor.tsx`)
- Add the "Surface to inbox (AI)" textarea + names/aliases input bound to `local.surface_ai_rule` / `local.surface_names`, persisted in `save()`.
- Add `surfaced_to_inbox` to `reasonLabel`/`reasonMeta` (e.g. label "Surfaced", inbox icon) so the badge renders.

### 9. Verification
- Typecheck touched files; run `search-scope` and `filter-engine` vitest suites.
- Drive the live preview: open a folder, set a surface rule, confirm save; confirm existing folders without a rule behave exactly as before.
