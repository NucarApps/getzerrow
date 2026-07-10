## Problem

On the Meetings page, the Upcoming tab and the "Not recorded" rows in the Past tab show events from **all** inboxes that have calendar access — not just the inboxes where meeting recording is turned on. You have 3 inboxes with calendar access but only chris@nucar.com has auto-record enabled, so events from the other two still appear.

The two server functions that feed these lists filter accounts by `calendar_access = true` only. They ignore the per-inbox `auto_record_meetings` flag (the "Auto-record meetings" toggle in Meeting settings).

## Fix

Scope both list queries to inboxes that have recording turned on, so events from inboxes where recording is off never appear on the Meetings page.

### `src/lib/meetings.functions.ts`

1. **`listAllUpcomingCalendarEvents`** (feeds the Upcoming tab): change the accounts query to also require `auto_record_meetings = true`, i.e. add `.eq("auto_record_meetings", true)` alongside the existing `.eq("calendar_access", true)`.

2. **`listRecentUnrecordedEvents`** (feeds the "Not recorded" rows in the Past tab): apply the same `.eq("auto_record_meetings", true)` filter.

No other logic changes are needed — the reconnect-prompt handling, per-event mode selection, and sorting all continue to work; they just operate on the reduced set of recording-enabled inboxes.

## Result

- Upcoming and Past tabs show meetings only from inboxes where auto-record is on (currently just chris@nucar.com).
- Turning auto-record on for another inbox in Meeting settings makes its events appear; turning it off removes them.
- The per-inbox Meeting settings cards are unaffected (they're still driven by explicit account selection).

## Note / open question

This ties "which inboxes' meetings I see" directly to the per-inbox auto-record toggle. If instead you'd want events to still be *visible* from all calendar-connected inboxes but only *auto-recorded* for enabled ones, that's a different behavior — let me know and I'll adjust. The plan above matches your stated expectation: only the inbox turned on for meetings should show events.