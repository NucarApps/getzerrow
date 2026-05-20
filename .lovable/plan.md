I found the likely cause: the “remove label” action strips the folder from matching past emails, but the current folder view is paginated and filtered by `folder_id`. After removal, those emails disappear from that folder, but they may not be visible in the current UI because:

- folder-specific views show only `folder_id = current folder`
- the All/Unsorted views currently exclude archived emails
- many folder-labeled Gmail messages are stored as archived, so after `folder_id` becomes null they can become hard to find
- search only scans the most recent 500 stored emails, not Gmail directly

Plan:

1. **Make the right-click strip action update the visible list immediately**
   - When “Remove folder label from past emails” succeeds, remove matching emails from the current folder cache right away.
   - This makes the current folder view reflect the action without waiting for a refetch.

2. **Keep stripped emails findable**
   - When stripping a folder label, also set `is_archived = false` for those emails in the local database.
   - This puts them back into the app’s All/Unsorted views without re-applying a folder label.
   - It will still not “move to Inbox” as a rule for future mail; it only makes the stripped past email visible outside the folder.

3. **Improve search visibility for the missing email**
   - Increase search so it checks a larger recent local corpus, and include archived/stripped emails.
   - This helps find messages like the 9:28 email even after label changes.

4. **Add a direct fallback for linked Gmail folders**
   - If a folder view reaches the end of local results, keep pulling the next 50 from Gmail for that linked label.
   - This preserves the “always load the next 50 from Gmail” behavior for Gmail-synced folders.

5. **Validate with the database**
   - Re-check the sender/time window after the change to confirm whether the 9:28 email is now stored, visible, or genuinely not yet ingested from Gmail.