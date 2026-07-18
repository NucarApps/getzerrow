## Goal

Stop auto-creating company groups/labels on ingest. Instead:
1. **Suggest** groups when a contact is added (match existing labels first, or offer to create).
2. Give each label its own **auto-assignment rules** (domains, AI category) so future contacts match to *existing* labels instead of spawning duplicates.

---

## 1. Turn off auto-creation

- `auto-company-subgroups.functions.ts`: gate the "create subgroup per distinct company" behavior behind a new user setting `contact_settings.auto_create_company_subgroups` (default **off** going forward).
- `resolveContactCompany` (in `crud.functions.ts`) keeps linking `company_id` when a clear existing match is found (by canonical name or alias), but **stops creating** new `companies` rows silently. If no match, leaves `company_id` null and emits a suggestion instead.
- Existing auto-created subgroups are left in place; user cleans them up via the duplicates drawer already built.

## 2. Label auto-assignment rules (the core new feature)

New table `contact_group_rules` attached to each `contact_groups` row:

```text
contact_group_rules
  id, user_id, group_id
  rule_type      enum: 'domain' | 'company_id' | 'ai_category'
  value          text        -- domain string, company uuid, or category slug
  auto_apply     bool        -- true = add on match, false = suggest only
  created_at
  unique(group_id, rule_type, value)
```

Semantics on contact insert/update:
- Collect candidate rules by matching the contact's email domain(s), linked `company_id`, and (if enrichment ran) inferred AI category (`software`, `automotive`, `finance`, …).
- `auto_apply=true` rules → membership added immediately.
- `auto_apply=false` rules → written to existing `contact_group_suggestions` for review.

## 3. Suggestion flow on Add Contact

In `ContactDrawer` / contact form:
- After email/company fields fill in, call a new `suggestGroupsForContact` server fn that returns:
  - **Exact/close label matches** by company name, alias, and domain rules.
  - **AI-inferred category** (reuse Gemini enrichment) → suggested existing label with that `ai_category` rule, or offer to "create new label for Software".
- Render a chip row: "Suggested: Nissan · Automotive". User taps to accept; nothing is auto-added unless a rule with `auto_apply=true` fires.

## 4. Per-label settings UI

Edit dialog for a label (`contact_groups` row) gets a new **Auto-assign** section:
- Domains list (add/remove chips): "anyone from nissanusa.com goes here"
- Linked companies (multi-select from `companies`)
- AI category dropdown: none / Software / Automotive / Finance / Legal / Media / … (seeded list)
- Toggle: **Auto-apply** vs **Suggest only**

Stored as rows in `contact_group_rules`.

## 5. AI category on contacts

Add `contacts.ai_category text` populated by the existing enrichment run (`enrich.functions.ts`) — small addition to the Gemini prompt returning one slug from a fixed vocabulary. Used by rule matching in step 2.

## 6. Backfill helper

One-shot server fn `applyGroupRulesToAllContacts` (admin action in Contacts settings): re-evaluates every contact against current rules. Lets the user seed rules once and pull existing contacts into the right labels without editing each.

---

## Technical notes

- Migration: new table + GRANTs + RLS scoped to `auth.uid()`; add `ai_category` column to `contacts` and `contact_settings.auto_create_company_subgroups` bool.
- Suggestion writes reuse existing `contact_group_suggestions` table — no new suggestion surface needed.
- Rule matching is a pure function in `src/lib/contacts/group-rules.ts` (testable, no Supabase imports), called from `crud.functions.ts` on insert/update and from the new `suggestGroupsForContact` fn.
- No changes to CardDAV/Google sync semantics — rules fire on the same `crud.functions.ts` upsert path both syncs already use.

---

## Open questions before I build

1. When a rule matches an **existing** label, do you want it applied silently (`auto_apply=true` default) or always shown as a suggestion first for the first N contacts?
2. Should the AI category be a **fixed** vocabulary (Software, Automotive, Finance, Legal, Media, Healthcare, Retail, Nonprofit, Government, Other) or freeform where AI picks any string?
3. Keep the existing auto-created Nissan-style subgroups as-is (you clean via the duplicates drawer), or run a one-time pass that converts each into a label + a domain rule and then deletes the auto-parent scaffolding?
