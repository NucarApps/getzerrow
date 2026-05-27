## What I found

Your Zerrow inbox is filtering correctly for rows that have both:
- `is_archived = false`
- `raw_labels` contains `INBOX`

The two messages currently visible in Zerrow match those fields:
- Mark Zarif — `Fwd: FW: DCD Automotive` — has `INBOX`
- Mark Zarif via Google Sheets — spreadsheet share — has `INBOX`

The two missing screenshot messages are present in Zerrow's database, but their local label state says they are not in the Gmail inbox:

1. **Mark Zarif — `Fwd: Reynolds & Reynolds Innovation Center Visit`**
   - `gmail_message_id`: `19e648f0dd00ff52`
   - `classified_by`: `inbox_override`
   - `classification_reason`: `Restored: always-inbox rule (was incorrectly archived by old global_exclude logic)`
   - current local state: `is_archived = true`, `raw_labels = [CATEGORY_PERSONAL, IMPORTANT]`
   - why hidden: it is missing `INBOX` locally and is marked archived locally

2. **PB Service1279 — `Returned Wire Notifications - MANUEL DE SANTAREN`**
   - `gmail_message_id`: `19e69ed239f2dd8d`
   - `classified_by`: `manual_inbox`
   - `classification_reason`: `Moved to Inbox manually`
   - current local state: `is_archived = false`, `raw_labels = [IMPORTANT, CATEGORY_PERSONAL]`
   - why hidden: it is missing `INBOX` locally, even though it was manually moved back to Inbox

## Likely cause

The earlier reversal cleaned up the over-restored historical messages by removing `INBOX` and marking rows archived when `classification_reason` included `restored to inbox`. That fixed the “all emails show again” issue, but it also exposed two legitimate inbox cases where Zerrow's local row no longer matches Gmail's current visible inbox state.

There is also a code issue in `moveEmailToInbox`: it sets `is_archived = false`, but does not update local `raw_labels` to include `INBOX`. That explains the PB Service1279 row: Gmail was modified, but Zerrow's inbox query still hides it because the local label array lacks `INBOX`.

## Implementation plan

1. **Fix the manual move-to-inbox code path**
   - Update `moveEmailToInbox` in `src/lib/gmail.functions.ts` so it fetches the current `raw_labels` and writes them back with `INBOX` added.
   - Keep the existing Gmail API label modification.
   - This prevents future manually restored emails from being hidden by the `raw_labels` inbox filter.

2. **Add a targeted one-time data repair**
   - Repair only the two confirmed missing rows by `gmail_message_id`:
     - `19e648f0dd00ff52`
     - `19e69ed239f2dd8d`
   - Set `is_archived = false` and add `INBOX` into `raw_labels` without duplicating labels.
   - Do not bulk-restore old `inbox_override` history again.

3. **Validate after repair**
   - Re-query the active inbox condition for this Gmail account and confirm all four screenshot messages now match the Zerrow inbox filter.
   - Avoid changing the inbox view filter because it is currently doing the right thing: showing only messages that are actually labeled Inbox locally.