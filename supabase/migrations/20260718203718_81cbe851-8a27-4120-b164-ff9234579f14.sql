
-- 1) Per-label auto-assignment rules
CREATE TABLE public.contact_group_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.contact_groups(id) ON DELETE CASCADE,
  rule_type text NOT NULL CHECK (rule_type IN ('domain','company_id','ai_category')),
  value text NOT NULL,
  auto_apply boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, rule_type, value)
);

CREATE INDEX contact_group_rules_user_type_value_idx
  ON public.contact_group_rules (user_id, rule_type, lower(value));
CREATE INDEX contact_group_rules_group_idx
  ON public.contact_group_rules (group_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_group_rules TO authenticated;
GRANT ALL ON public.contact_group_rules TO service_role;
ALTER TABLE public.contact_group_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own group rules"
  ON public.contact_group_rules FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER contact_group_rules_updated_at
  BEFORE UPDATE ON public.contact_group_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2) AI-inferred category on contact (used by 'ai_category' rules).
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS ai_category text;

CREATE INDEX IF NOT EXISTS contacts_ai_category_idx
  ON public.contacts (user_id, ai_category);
