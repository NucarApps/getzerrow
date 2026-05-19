
-- Folders backed by Gmail labels
CREATE TABLE public.folders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1',
  gmail_label_id TEXT,
  ai_rule TEXT,
  auto_archive BOOLEAN NOT NULL DEFAULT false,
  auto_mark_read BOOLEAN NOT NULL DEFAULT false,
  priority INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.folder_filters (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  folder_id UUID NOT NULL REFERENCES public.folders(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  op TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.emails (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  gmail_message_id TEXT NOT NULL UNIQUE,
  thread_id TEXT,
  from_addr TEXT,
  from_name TEXT,
  to_addrs TEXT,
  subject TEXT,
  snippet TEXT,
  body_text TEXT,
  body_html TEXT,
  received_at TIMESTAMPTZ,
  is_read BOOLEAN NOT NULL DEFAULT false,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  has_attachment BOOLEAN NOT NULL DEFAULT false,
  folder_id UUID REFERENCES public.folders(id) ON DELETE SET NULL,
  ai_summary TEXT,
  ai_confidence REAL,
  classified_by TEXT,
  raw_labels TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX emails_user_received_idx ON public.emails(user_id, received_at DESC);
CREATE INDEX emails_folder_idx ON public.emails(folder_id);

CREATE TABLE public.sync_state (
  id INT PRIMARY KEY DEFAULT 1,
  user_id UUID,
  last_history_id TEXT,
  watch_expiration TIMESTAMPTZ,
  last_poll_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sync_state_single CHECK (id = 1)
);
INSERT INTO public.sync_state (id) VALUES (1);

CREATE TABLE public.reply_drafts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email_id UUID NOT NULL REFERENCES public.emails(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  draft_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folder_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reply_drafts ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read/write (single-tenant app)
CREATE POLICY "auth_all_folders" ON public.folders FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_filters" ON public.folder_filters FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_emails" ON public.emails FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_sync" ON public.sync_state FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_drafts" ON public.reply_drafts FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.emails;
ALTER PUBLICATION supabase_realtime ADD TABLE public.folders;
ALTER TABLE public.emails REPLICA IDENTITY FULL;
ALTER TABLE public.folders REPLICA IDENTITY FULL;
