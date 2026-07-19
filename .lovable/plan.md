## Problem
On the company detail page's **Labels** tab, you can only toggle labels that already exist. If none exist (or you want a new one), the current copy says "create one from the Contacts page first" — there's no way to add a label inline.

## Fix
Add an inline "New label" input inside `CompanyLabelsSection` in `src/routes/_authenticated/contacts.companies.$companyId.tsx`, next to the existing chips.

### Behavior
- Small input + "Add" button (Enter also submits) rendered below the label chips.
- On submit:
  1. Call existing `createContactGroup({ name })` server fn to create the label (scoped to the current user, deduped by name).
  2. Call existing `setCompanyLabels` with the new group id appended to the current selection — so the new label is created *and* immediately applied to this company (and propagated to its contacts, matching current chip-click behavior).
  3. Invalidate `["contact-groups"]` and `["company-labels", companyId]` so the new chip appears pre-selected.
- Show toast on success/error using the same pattern already used by `saveMut`.
- When there are zero labels yet, replace the "create one from the Contacts page first" message with the same inline input so users can create their first label right here.

### Files touched
- `src/routes/_authenticated/contacts.companies.$companyId.tsx` — extend `CompanyLabelsSection` only. No new files, no server-fn changes, no schema changes.

### Out of scope
- No changes to color picker, rules, or auto-subgroup behavior. New labels use whatever default `createContactGroup` already assigns; you can still edit color/rules from the Contacts page.
