-- Persistent per-folder chat memory: message history + rolling summary state.

CREATE TABLE public.folder_chat_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  folder_id UUID NOT NULL REFERENCES public.folders(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL DEFAULT '',
  actions JSONB,
  applied_action_indexes JSONB NOT NULL DEFAULT '[]'::jsonb,
  summarized BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_folder_chat_messages_folder ON public.folder_chat_messages (folder_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.folder_chat_messages TO authenticated;
GRANT ALL ON public.folder_chat_messages TO service_role;

ALTER TABLE public.folder_chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own folder chat messages"
  ON public.folder_chat_messages FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.folder_chat_state (
  folder_id UUID NOT NULL PRIMARY KEY REFERENCES public.folders(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  summarized_through TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.folder_chat_state TO authenticated;
GRANT ALL ON public.folder_chat_state TO service_role;

ALTER TABLE public.folder_chat_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own folder chat state"
  ON public.folder_chat_state FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_folder_chat_state_updated_at
  BEFORE UPDATE ON public.folder_chat_state
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();