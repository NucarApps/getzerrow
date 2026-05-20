## Plan

1. **Raise the remaining request-size cap**
   - The visible validator is already at 10,000 characters, so the remaining “too big” message is likely coming from the server function RPC/request payload limit rather than the database.
   - Move daily-summary schedule creation/update to raw API routes so large instruction text is sent as a normal JSON body instead of through the server function payload path.

2. **Keep the same permissions and validation**
   - Reuse the current authenticated session and ownership checks.
   - Keep validation for name, schedule time, timezone, and instructions, with instructions capped at 10,000 characters.

3. **Update the schedule form save calls**
   - Change the Daily Summary create/update UI to call the new API endpoints.
   - Preserve the existing UI behavior: close the form, refresh schedules, and show the same toast errors on failure.

4. **Add a clear character counter**
   - Add an instructions counter like `4,512 / 10,000` under the textarea so it’s obvious when the prompt is within the accepted limit.
   - Disable save and show a friendly message if the user exceeds 10,000 characters.

## Technical notes

- No database migration is needed because `folder_summary_schedules.instructions` is already `text`.
- I’ll avoid changing unrelated folder behavior or summary-generation logic.