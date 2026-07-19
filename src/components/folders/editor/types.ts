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
