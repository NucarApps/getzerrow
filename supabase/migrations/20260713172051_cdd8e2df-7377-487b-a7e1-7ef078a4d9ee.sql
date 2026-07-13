ALTER TABLE public.folder_chat_messages
  ADD COLUMN IF NOT EXISTS discarded boolean NOT NULL DEFAULT false;