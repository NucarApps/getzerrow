// Shared types for the sync pipeline. Defined separately from the
// modules that use them so filter-engine.ts (pure logic, no Supabase)
// can be imported by anything without dragging the supabase client into
// the import graph.

/** Folder filter rule node — a leaf condition or an AND/OR group of
 * child nodes. The full tree is JSON-encoded in folders.filter_tree. */
export type RuleNode =
  | { type: "group"; op: "and" | "or"; children: RuleNode[] }
  | { type: "cond"; field: string; op: string; value: string };

/** A folder configuration row. Mirrors the columns selected by
 * loadAccountContext — keep field set in sync if you add to either. */
export type Folder = {
  id: string;
  name: string;
  gmail_label_id: string | null;
  ai_rule: string | null;
  learned_profile: string | null;
  last_learned_at: string | null;
  auto_archive: boolean;
  auto_mark_read: boolean;
  auto_star: boolean;
  hide_from_inbox: boolean;
  skip_ai: boolean;
  priority: number;
  gmail_account_id: string;
  filter_logic: "any" | "all";
  filter_tree: RuleNode | null;
  forward_to: string | null;
  min_ai_confidence: number;
  snooze_hours: number;
  overrides_inbox_override: boolean;
  /** When true, the calendar cold-email guard keeps known contacts out of
   * this folder (pins them to the inbox instead of filing them here). */
  is_cold_email: boolean;
  /** Natural-language "surface to inbox" rule. When non-empty, mail the
   * folder's deterministic rules route here is checked by the AI, which
   * can keep it visible in the inbox instead of tucking it away. */
  surface_ai_rule: string | null;
  /** Optional extra names/aliases (comma-separated) used alongside the
   * connected Gmail address for "is this addressed to me" judgments. */
  surface_names: string | null;
};

export type OverrideException = {
  override_id: string;
  field: string;
  op: string;
  value: string;
};

/** A single folder-filter row (folder_filters table). */
export type Filter = {
  id: string;
  folder_id: string;
  field: string;
  op: string;
  value: string;
};

/** A connected gmail_accounts row in the shape the sync code needs. */
export type GmailAccount = {
  id: string;
  user_id: string;
  email_address: string;
  history_id: string | null;
  watch_expiration: string | null;
};
