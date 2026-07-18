# Editable company name in the company dialog

Today the pencil on a company bucket opens `CompanyAliasesDialog`, which shows the company name as static title text. Add an inline edit so renaming it updates every contact currently grouped under that company.

## Behavior

- In the dialog header, replace the static `{companyName}` span with an inline editable field (click to edit, or a small pencil next to it) that seeds from the current bucket name.
- Save button appears when the name is changed and non-empty. Cancel reverts.
- On save: every contact in `contactIds` (already passed into the dialog — that's the full bucket, aliases included) gets `contacts.company` set to the new name. Auto-generated company subgroups reconcile so the subgroup name follows the rename.
- Toast: "Renamed N contacts to <new name>". Dialog stays open; header reflects the new name.
- Empty / whitespace-only name is rejected client-side.

## Files

1. `src/lib/contacts/crud.functions.ts` — add `renameCompanyForContacts` server fn.
   - Input: `{ contactIds: string[], newName: string }`, Zod-validated (trim, 1–200 chars).
   - `context.supabase.from("contacts").update({ company: newName }).eq("user_id", context.userId).in("id", contactIds)` (RLS also enforces ownership).
   - After update, call `reconcileAutoParentsForContacts(supabase, userId, contactIds)` from `@/lib/contacts/auto-company-subgroups.functions` so any auto-company subgroups rebuild to the new name.
   - Return `{ updated: <count> }`.

2. `src/components/contacts/CompanyAliasesDialog.tsx`
   - Add `useServerFn(renameCompanyForContacts)`.
   - Local state `nameDraft` seeded from `companyName` on open.
   - Header title becomes: logo + `<Input>` (compact, borderless-until-focus) + save/cancel buttons that show only when `nameDraft.trim() !== companyName && nameDraft.trim().length > 0`.
   - On save: call server fn, toast success, invalidate `["contacts"]` and `["company-aliases"]` and `["company-group-assignments"]` so the contacts list re-buckets under the new name.

3. `src/routes/_authenticated/contacts.index.tsx` — no logic change; the existing `queryClient.invalidateQueries({ queryKey: ["contacts"] })` triggered by the dialog will re-fetch and re-bucket. Verify the invalidation key matches what this page uses; adjust the invalidation keys in step 2 to match if different.

## Out of scope

- Renaming does **not** touch `company_aliases` domain mappings — those are keyed by domain, not name. Future emails from the same domain will still land in the (renamed) bucket.
- Auto-subgroups already use `normalizeCompanyName`; the rename flows through naturally on reconcile.
- No change to Google Contacts push in this step. If two-way sync is on, the next push will send the new `company` value up to Google per existing push logic.
