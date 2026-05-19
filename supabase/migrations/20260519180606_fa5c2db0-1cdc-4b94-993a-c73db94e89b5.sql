
ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS learned_profile text,
  ADD COLUMN IF NOT EXISTS last_learned_at timestamptz;

CREATE TABLE IF NOT EXISTS public.folder_examples (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.folders(id) on delete cascade,
  user_id uuid not null,
  gmail_message_id text not null,
  from_addr text,
  subject text,
  snippet text,
  source text not null default 'seed',
  created_at timestamptz not null default now(),
  unique (folder_id, gmail_message_id)
);

ALTER TABLE public.folder_examples ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_folder_examples"
ON public.folder_examples
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);

CREATE INDEX IF NOT EXISTS folder_examples_folder_idx ON public.folder_examples(folder_id);
