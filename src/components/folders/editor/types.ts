export type RuleNode =
  | { type: "group"; op: "and" | "or"; children: RuleNode[] }
  | { type: "cond"; field: string; op: string; value: string };

export type Folder = {
  id: string;
  name: string;
  color: string;
  gmail_label_id: string | null;
  ai_rule: string | null;
  learned_profile: string | null;
  last_learned_at: string | null;
  auto_archive: boolean;
  auto_mark_read: boolean;
  priority: number;
  gmail_account_id: string;
  filter_logic?: "any" | "all";
  auto_star?: boolean;
  hide_from_inbox?: boolean;
  skip_ai?: boolean;
  filter_tree?: RuleNode | null;
  forward_to?: string | null;
  min_ai_confidence?: number;
  snooze_hours?: number;
  overrides_inbox_override?: boolean;
  is_cold_email?: boolean;
  surface_ai_rule?: string | null;
  surface_names?: string | null;
  auto_relearn?: boolean;
  relearn_threshold?: number;
  emails_since_learn?: number;
};

// Columns backing the Folder type above. Used instead of select("*") by the
// shared "folders-full" queries so Gmail backfill bookkeeping columns (page
// tokens, oldest-received cursors) never ship to the client.
// (Kept as one string literal so supabase-js can type the select statically.)
export const FOLDER_COLUMNS =
  "id,name,color,gmail_label_id,ai_rule,learned_profile,last_learned_at,auto_archive,auto_mark_read,priority,gmail_account_id,filter_logic,auto_star,hide_from_inbox,skip_ai,filter_tree,forward_to,min_ai_confidence,snooze_hours,overrides_inbox_override,is_cold_email,surface_ai_rule,surface_names,auto_relearn,relearn_threshold,emails_since_learn" as const;

export type Filter = {
  id: string;
  folder_id: string;
  field: string;
  op: string;
  value: string;
};

export type GLabel = { id: string; name: string; type: string };

export type HistoryEmail = {
  id: string;
  subject: string | null;
  from_addr: string | null;
  from_name: string | null;
  received_at: string | null;
  classified_by: string | null;
  ai_confidence: number | null;
  ai_summary: string | null;
  snippet: string | null;
};

export type Schedule = {
  id: string;
  name: string;
  instructions: string;
  hour: number;
  minute: number;
  timezone: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string;
  last_error: string | null;
};
