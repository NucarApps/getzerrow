-- Thread-scope rules (rules upgrade, task 6): a folder with
-- run_on_threads=true evaluates its deterministic rules against the whole
-- thread (the incoming message plus recent prior messages), so a reply in
-- a thread whose earlier message matched still routes into the folder.
-- Default false — existing folders keep exact message-scope behavior.

ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS run_on_threads boolean NOT NULL DEFAULT false;
