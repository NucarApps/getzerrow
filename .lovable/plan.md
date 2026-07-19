## Manual contact merge with per-field primary picker

Extend the existing dedup infrastructure so a user can hand-pick a merge, choose exactly which values survive, and delete the losers cleanly across CardDAV/Google.

### Entry points

1. **Contacts list multi-select** — when 2+ contacts are checked, show a "Merge…" action that opens the merge dialog with those contacts preloaded.
2. **Contact detail** — new "Merge with…" menu item opens a contact-search combobox, then launches the merge dialog with the current + picked contact.
3. **Duplicate suggestions drawer** — replace one-click "Merge" with a "Review & merge" button that opens the same dialog preloaded with the suggested pair. The one-click path stays for AI-high-confidence auto-accept only.

### Merge dialog UX

`MergeContactsDialog.tsx` — one shared dialog for all three entry points.

- **Primary selector** at top: radio row of avatars/names; picking one sets it as the survivor (its id, source system link, and revision history are kept).
- **Scalar fields table** (display_name, first/last, title, company (+ company_id), notes, birthday, avatar_url + avatar_source): one row per field, each source contact is a radio column, "Custom…" input as a fourth column. Non-empty sources are preselected; primary wins ties.
- **Multi-value lists** (emails, phones): checkbox per value across all sources with dedupe by normalized form. Show label/type badges. User picks which to keep; one can be marked "primary" for each list.
- **Groups/labels**: shown as read-only "will be merged (union)" chip list, with an "Exclude" X per group for opt-out.
- **Company link**: if sources point at different company_id, radio-pick; if one is null, prefer the non-null.
- **Manual-override lock preservation**: any field the user explicitly picks becomes a `manual_overrides` entry on the survivor so enrichment won't overwrite it.
- Footer shows "N contacts will be deleted" and a Merge button.

### Server function

New `mergeContactsManual` in `src/lib/contacts/dedup.functions.ts`:

- Input (Zod): `{ primaryId, loserIds[], fields: { [key]: value }, emails: [{value,label,is_primary}], phones: [...], excludedGroupIds[], manualLockFields[] }`.
- Auth via `requireSupabaseAuth`; verifies all contacts belong to `userId`.
- In a single logical pass:
  1. Update survivor row with chosen scalar fields + merged `manual_overrides`.
  2. Replace `contact_emails` / `contact_phones` for survivor with the chosen deduped set (preserving existing rows where possible to keep google resource ids intact).
  3. Union `contact_group_members` from losers into survivor, minus excluded groups.
  4. Reassign FK references from losers → survivor: `contact_revisions`, `google_contact_links`, `contact_duplicate_suggestions`, `contact_enrichment_suggestions`, `task_completion_suggestions`, `meeting_participants`, `calendar_contacts`, `email_search_index` (any table with contact_id — enumerate from schema in one migration-free code pass).
  5. For each loser: insert `carddav_tombstones` + `google_contact_tombstones` rows (so iPhone/Google sync deletions), then `DELETE` the contact row. RLS cascades handle child rows.
  6. Bump CardDAV CTag + `resync_nonce` once at the end so iOS pulls the change in one shot.
  7. Reconcile auto-company subgroups for the survivor.
  8. Mark related pending `contact_duplicate_suggestions` as `merged`.
- Returns `{ survivorId, deletedCount }`.

### Wiring

- `src/routes/_authenticated/contacts.index.tsx`: add bucket-level "Merge selected" button when ≥2 contacts are checked; opens dialog.
- `src/components/contacts/ContactDetailView.tsx`: overflow-menu "Merge with…" launches a `ContactPickerCombobox` (search by name/email/phone via existing contacts query) then dialog.
- `src/components/contacts/DuplicateSuggestionsDrawer.tsx`: swap the "Merge" button for "Review & merge" that opens the dialog; keep AI dismiss/ignore actions as-is.

### Safety / tests

- `dedup.functions.ts` test: verify emails/phones dedupe, group union w/ exclusions, tombstones written, losers deleted, manual_overrides recorded.
- Guard: reject merge if `primaryId ∈ loserIds`, if any contact is not owned by user, or if list is <2.
- Wrap the reassignment + delete in try/catch that surfaces the failing table to the toast (mirrors the hardened company-merge pattern).

### Non-goals

- No bulk 3+ automated merges via AI (already covered by existing suggestions flow).
- No soft-archive mode (user chose hard delete + tombstones).
- No changes to company-merge logic — this is contacts only.