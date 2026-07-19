## Plan

1. **Fix the false-success merge path**
   - Update the Contacts page inline merge prompt so when the buckets are backed by real company records, it calls the real company merge operation instead of only renaming contact text or adding domain aliases.
   - Keep the existing alias/rename behavior only for buckets that do not have company records yet.

2. **Make the UI clear immediately after merge**
   - After a real company merge, invalidate the contacts, companies, company aliases, label/group, and duplicate-company queries so the merged source row and merge button disappear without a manual refresh.
   - If the merge fails, show the real backend error instead of a success toast.

3. **Clean up the current Hermes duplicate**
   - Merge the remaining Hermes company record into the survivor so the two visible Hermes rows collapse to one.
   - Preserve both contacts and the shared `hermes.com` website/domain context.

4. **Add a regression test for this case**
   - Cover the case where two contacts have the same visible company name and website/domain but are linked to two different company records.
   - Assert the merge path chooses `mergeCompanies`, not the old rename-only path.

## Technical notes

I confirmed the current Hermes state has two company rows:

- `Hermes Boston` with one contact
- `Palm Beach Hermes` with one contact

Both linked contacts have `company = Hermes` and `website = https://hermes.com`, with no saved `company_domains` rows. The Contacts page prompt is currently using the bucket-level alias/rename merge, which can show a success toast while leaving both company records intact. The fix is to route linked-company buckets through the real company merge function.