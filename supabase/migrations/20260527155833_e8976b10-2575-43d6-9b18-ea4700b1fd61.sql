-- Delete the stale row and enqueue a fresh job so the worker re-ingests
-- the message and the inbox_override classifier restores INBOX both in
-- Gmail and locally.
DELETE FROM public.emails WHERE gmail_message_id = '19e6a1455025344d';

INSERT INTO public.message_jobs (
  gmail_account_id, user_id, gmail_message_id, status, priority, next_run_at
) VALUES (
  'adb85c80-ab6b-45aa-ac0a-d9e091710637',
  'ad1cc507-52b7-470c-96f1-9d7e56ddf16c',
  '19e6a1455025344d',
  'pending',
  0,
  now()
)
ON CONFLICT DO NOTHING;