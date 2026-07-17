## Plan

1. **Fix the People API group field mask**
   - Update the Google Contacts group list request to use the valid People API field mask names for `contactGroups.list`.
   - Remove unsupported/invalid mask fields that are causing the `Invalid groupFields mask path: "formatted_name"` / `"formattedName"` error.

2. **Keep group naming behavior intact**
   - Preserve the existing fallback that uses the group `name` from Google Contacts for Zerrow group names.
   - Keep the local type permissive enough for any fields returned by other group endpoints, but don’t request invalid fields from the list endpoint.

3. **Add a regression test**
   - Add or update a Google Contacts client test so `listContactGroupsPage` cannot reintroduce invalid `groupFields` values like `formattedName` or `formatted_name`.

4. **Verify the fix**
   - Run the focused Google Contacts tests after the code change.
   - If tests pass, you can try **Sync now** again; the request should no longer fail on the group field mask.