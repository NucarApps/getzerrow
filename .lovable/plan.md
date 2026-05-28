## Plan

Fix the rule group behavior so an `AND` group only files an email when every condition in the group matches.

### What I’ll change

1. **Make Gmail scan respect rule groups**
   - Update `scanGmailForFolder` so it no longer flattens a rule tree into separate OR-style searches.
   - For your example, it should search as one combined AND query:
     ```text
     from:docusign subject:Completed newer_than:6m
     ```
     not two independent searches.

2. **Use the shared filter engine for scanned emails**
   - Replace the scan path’s custom single-rule matcher with `matchByFilters`, the same engine used by normal incoming mail.
   - This keeps `AND` / `OR` / nested groups consistent everywhere.

3. **Show matched tree rules correctly in the detail panel**
   - Keep showing the matching leaves for rule groups.
   - Once the scan path stops incorrectly filing one-condition matches, the panel will only show rule group matches for emails that satisfy the full group.

4. **Add tests**
   - Add coverage for:
     - AND group → one combined Gmail query
     - OR group → separate queries
     - nested AND/OR groups → combined branch queries
     - skipped `regex` and negative rules

### Files expected to change

- `src/lib/gmail.functions.ts`
- Likely a small extracted helper/test file such as:
  - `src/lib/sync/gmail-query-builder.ts`
  - `src/lib/sync/gmail-query-builder.test.ts`

### Expected result

The email titled `Complete with Docusign...` will not be filed by the rule `subject starts with Completed`, because `Complete` does not satisfy `Completed`, even though the sender/domain matches DocuSign.