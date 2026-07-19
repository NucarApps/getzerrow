-- Per-meeting recording choice. An exclusion row already keeps the notetaker
-- out of a meeting; `mode` now records why:
--   'off'       — don't capture this meeting at all (previous behavior)
--   'in_person' — the user plans to record it themselves with the phone/mic
-- Meetings without a row keep the default: send the notetaker.
ALTER TABLE public.meeting_autojoin_exclusions
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'off'
  CHECK (mode IN ('off', 'in_person'));
