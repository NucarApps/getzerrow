CREATE TABLE public.inbox_override_exceptions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  override_id uuid NOT NULL REFERENCES public.inbox_overrides(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  field text NOT NULL,
  op text NOT NULL,
  value text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_ioe_override ON public.inbox_override_exceptions(override_id);
CREATE INDEX idx_ioe_user ON public.inbox_override_exceptions(user_id);

ALTER TABLE public.inbox_override_exceptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own override exceptions"
ON public.inbox_override_exceptions
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.folders
ADD COLUMN overrides_inbox_override boolean NOT NULL DEFAULT false;