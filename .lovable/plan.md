Goal: when you open the inbox, it should already reflect the processed Zerrow state. You should not see mail load and then disappear one by one as classification/foldering finishes.

Plan:

1. Stop showing intermediate “pending” mail in the inbox
- Treat messages still being classified or filed as not ready for the Zerrow inbox.
- Hide `pending` / `pending_ai` rows from the normal Inbox, No rules, and folder views until backend processing finishes.
- Keep All mail available as the diagnostic/full-mail view if needed.
- Update the realtime cache logic so an intermediate insert does not briefly appear and then disappear; the row only enters the inbox once its final classification says it belongs there.

2. Make the initial inbox load wait for a settled backend state
- Replace the current lightweight entry catch-up with a stricter “settle inbox” server function.
- On inbox entry, it will pull Gmail history, drain newly queued live mail, and try to finish the immediate classification queue within a short safety budget.
- If the budget is exceeded, the page will still load, but because pending rows are hidden, you won’t see the one-by-one cleanup.

3. Strengthen always-on processing when nobody is logged in
- Verify the backend schedules that run Gmail polling and mail processing without a browser session.
- Update the live-processing schedule/limit if needed so newly queued live mail is drained more aggressively server-side.
- Keep webhook, polling, queue processing, and reconcile jobs as backend-only work so they continue when the site is closed or you are logged out.

4. Clean up the “Catching up…” experience
- Only show it while the first settled fetch is waiting and there is no usable cached list.
- Do not show a visible “catching up” pulse after the inbox has rendered unless the user manually clicks Refresh.

5. Verify the behavior
- Check backend cron/job state after the change.
- Add/update tests for the realtime list membership rule so pending mail cannot flash into the inbox.
- Verify in the browser that opening the inbox no longer shows rows disappearing one by one after load.