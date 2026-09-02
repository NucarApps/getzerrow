-- One scheduled meeting per calendar event per user.
--
-- The auto-join scheduler checked for an existing row and then inserted,
-- with nothing in between: two overlapping cron runs could both pass the
-- check and both create a (billable) Recall bot for the same event. The
-- index lets the insert itself be the claim — the loser gets 23505 and
-- stops before spending anything.
--
-- Partial: rows not sourced from a calendar carry a null event id.
CREATE UNIQUE INDEX IF NOT EXISTS meetings_user_calendar_event_key
  ON public.meetings (user_id, calendar_event_id)
  WHERE calendar_event_id IS NOT NULL;
