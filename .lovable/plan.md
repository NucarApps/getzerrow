## AI-suggested contact groups

Add an "AI suggestions" panel on the Contacts page that reviews the user's contacts and proposes new groups (and subgroups) plus which contacts belong in each. The user reviews suggestions and accepts them one-by-one or in bulk — nothing changes without confirmation.

### User flow
1. On `/contacts`, a new "Suggest groups with AI" button (near the existing group controls) opens a drawer.
2. The drawer streams a scan: "Analyzing 459 contacts…" then lists suggested groups.
3. Each suggestion shows: proposed name, optional parent group, short rationale, and the contacts that would be added (with counts).
4. Actions per suggestion: **Create group & add contacts**, **Add to existing group** (dropdown of current groups), **Edit name**, **Dismiss**. A bulk "Accept all" is also available.
5. Ungrouped contacts are prioritized; already-grouped contacts can be suggested as subgroup candidates (e.g., split a large "Clients" group by company).

### What the AI considers
- Company / title / domain of email (biggest signal — cluster by employer).
- Existing groups + parent hierarchy (so suggestions extend, don't duplicate).
- Notes / relationship summary (already stored, decrypted server-side).
- Recent email interaction volume (optional signal for "VIP" / "Frequent" style groups).
- Contact source (Google label, CardDAV, manual).

The AI is instructed to return between 3 and 15 suggestions, favor useful clusters (>=3 contacts), and propose subgroups only when a parent group is oversized (>25 contacts) or when a clear sub-cluster exists (e.g., company inside an industry group).

### Technical outline

**New server function** `src/lib/contacts/suggest-groups.functions.ts`
- `suggestContactGroups()` — auth-protected. Loads:
  - All contacts (id, name, email domain, company, title, city, source, group memberships).
  - Existing contact_groups (name, parent, member count).
- Builds a compact prompt (only signals, no PII beyond what's needed) and calls Lovable AI Gateway via the AI SDK with a small structured-output schema:
  ```
  { suggestions: [{ name, parent_group_name?, rationale, contact_ids[], kind: "new"|"subgroup"|"merge_into_existing", existing_group_id? }] }
  ```
- Model: `google/gemini-3.5-flash` (fast, cheap, strong at clustering). No schema bounds — enforce sizes in the prompt and clamp in code (per `ai-sdk-agent-patterns`).
- Returns suggestions with resolved contact previews (name/email for first ~5 members).
- Cache latest run in a new table `contact_group_suggestions` (see migration below) so the drawer can reopen without re-billing.

**Apply function** `applyContactGroupSuggestion()`
- Reuses existing `createContactGroup` + `addContactsToGroups` logic.
- Supports "add to existing" by skipping group creation.
- Marks suggestion row as `accepted` / `dismissed`.

**Migration** — new table `contact_group_suggestions`:
- `run_id`, `user_id`, `name`, `parent_group_id` (nullable), `existing_group_id` (nullable), `contact_ids` (uuid[]), `rationale`, `kind`, `status` ('pending'|'accepted'|'dismissed'), timestamps.
- RLS to `auth.uid()`, grants to `authenticated` + `service_role`.

**UI** `src/components/contacts/GroupSuggestionsDrawer.tsx`
- Uses `useQuery` for the cached run + a "Rescan" button that calls the server fn.
- Card per suggestion with member preview, accept/dismiss buttons, and an inline group-picker for "add to existing".
- Toasts on success; invalidates the contacts + groups queries so the list updates immediately.

**Entry point** — add "Suggest groups with AI" button on `src/routes/_authenticated/contacts.index.tsx` next to the existing group controls.

### Guardrails
- Never auto-apply — always requires user confirmation.
- Skip contacts that already belong to a group with the same suggested name.
- Respect the 4-level nesting cap (reject parent suggestions that would exceed depth).
- Rate-limit rescan (1 per 5 min) to control AI cost.
- No PII sent to the model beyond first name + email domain + company + title + notes snippet.

### Out of scope
- Automatic recurring scans (can add later as a cron).
- Renaming/reorganizing existing groups (only proposes additions).
- CardDAV/Google push happens automatically via existing sync once the group is created.