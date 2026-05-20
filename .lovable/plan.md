## Goal

In the email reader, the "Why this folder?" panel should clearly explain what rule (or AI prompt) routed the email — not a vague "FILTER" pill with "No reasoning recorded".

## Changes

### 1. Rename the badge: "Filter" / "Domain rule" → "Rule"

`src/routes/_authenticated/index.tsx` — `ClassifiedChip`:
- `filter` → label "Rule", icon `FilterIcon`
- `domain_rule` → label "Rule" (same), so the user sees one consistent concept
- Keep `ai` → "AI", `gmail_label` → "Gmail label", `manual_move` → "Manual"

### 2. Load the folder's actual rules and show them in the panel

The reader already has `email.folder_id`. Add a query that pulls the folder + its `folder_filters` rows + `ai_rule` for the email's folder, then render a structured "Triggered by" block inside the collapsible:

```
Triggered by
  Rule: from contains "@na.honda.com"   → Factory
  Rule: subject contains "Daily Doc"    → Factory
AI rule (folder prompt)
  "Anything from Honda factory contacts about daily docs or shipments"
Reasoning recorded for this email
  Matched Gmail label "Factory"           (or italic fallback if null)
```

Rendering rules per `classified_by`:
- `filter` / `domain_rule` → list all `folder_filters` for the folder; if `classification_reason` recorded the specific match, highlight that row.
- `ai` → show the folder's `ai_rule` (the natural-language prompt the user wrote) plus the recorded `classification_reason` (AI's per-email rationale) plus the existing confidence bar.
- `gmail_label` → show "Mapped to Gmail label '<label>'" using the folder's `gmail_label_id` / name.
- `manual_move` → show "Moved manually" + reason.
- `none` → italic fallback (unchanged).

This means old emails with `classification_reason = null` will still get a useful explanation, because we always show the folder's rule set as the source of truth.

### 3. Data fetching

New `useQuery` keyed `["folder-rules", email.folder_id]` that runs only when `email.folder_id` is set. Two parallel selects via the existing browser `supabase` client (RLS already scopes to the user):

```ts
supabase.from("folders").select("id, name, ai_rule, gmail_label_id").eq("id", folderId).single()
supabase.from("folder_filters").select("field, op, value").eq("folder_id", folderId)
```

No new server function needed; no schema changes.

### Files touched

- `src/routes/_authenticated/index.tsx` — chip label map, new `useQuery`, new `TriggeredBy` sub-component rendered inside the existing `<CollapsibleContent>` above the recorded-reason paragraph.

No backend, sync, or migration changes.