// Turning a proposed folder-chat action into (a) the sentence the user reads
// before approving it and (b) the patch applied to the open editor.
//
// Both directions are key-by-key: every settings key the AI may propose has
// to be named in `describeSettings` or the user approves a change they were
// never shown, and named again in `settingsToLocalPatch` or the change they
// approved is silently dropped from the editor. That is why this lives here
// rather than inside the panel — the two lists have to be tested exhaustively
// against the `SettingsPatch` type.

import type { Folder } from "@/components/folders/editor/types";

export type SettingsPatch = {
  name?: string;
  color?: string;
  priority?: number;
  auto_archive?: boolean;
  auto_mark_read?: boolean;
  auto_star?: boolean;
  hide_from_inbox?: boolean;
  skip_ai?: boolean;
  overrides_inbox_override?: boolean;
  is_cold_email?: boolean;
  forward_to?: string | null;
  snooze_hours?: number;
  min_ai_confidence?: number;
  filter_logic?: "any" | "all";
};

export type FolderChatAction =
  | {
      type: "add_filter";
      field: "from" | "domain" | "subject";
      op: "contains" | "equals" | "starts_with" | "not_contains" | "not_equals" | "domain_in";
      value: string;
      why: string;
    }
  | { type: "remove_filter"; filter_id: string; why: string }
  | { type: "update_folder_rule"; ai_rule: string; why: string }
  | { type: "update_folder_profile"; learned_profile: string; why: string }
  | { type: "update_folder_settings"; settings: SettingsPatch; why: string };

/**
 * The boolean settings, in the order they are described. Keyed by the patch
 * key so a new boolean setting that is not given a label here shows up as a
 * missing sentence rather than as a wrong one.
 */
export const BOOL_LABELS: Record<string, string> = {
  auto_archive: "auto-archive",
  auto_mark_read: "auto mark-read",
  auto_star: "auto-star",
  hide_from_inbox: "hide from inbox",
  skip_ai: "rules only",
  overrides_inbox_override: 'beat "always send to inbox"',
  is_cold_email: "cold-email folder",
};

/** One sentence per key the patch actually sets. */
export function describeSettings(s: SettingsPatch): string[] {
  const parts: string[] = [];
  if (s.name !== undefined) parts.push(`Rename to "${s.name}"`);
  if (s.color !== undefined) parts.push(`Set color to ${s.color}`);
  if (s.priority !== undefined) parts.push(`Set priority to ${s.priority}`);
  for (const key of Object.keys(BOOL_LABELS)) {
    const v = (s as Record<string, unknown>)[key];
    if (typeof v === "boolean") parts.push(`${v ? "Turn on" : "Turn off"} ${BOOL_LABELS[key]}`);
  }
  if (s.forward_to !== undefined)
    parts.push(s.forward_to ? `Auto-forward to ${s.forward_to}` : "Stop auto-forwarding");
  if (s.snooze_hours !== undefined)
    parts.push(s.snooze_hours > 0 ? `Snooze on arrival for ${s.snooze_hours}h` : "Turn off snooze");
  if (s.min_ai_confidence !== undefined)
    parts.push(`Set min AI confidence to ${Math.round(s.min_ai_confidence * 100)}%`);
  if (s.filter_logic !== undefined) parts.push(`Match ${s.filter_logic} filters`);
  return parts;
}

/** The single line shown next to an action's approve checkbox. */
export function describeAction(action: FolderChatAction): string {
  if (action.type === "add_filter") {
    if (action.op === "domain_in") {
      return `Add allowlist: only mail from ${action.value
        .split(/[\s,;]+/)
        .filter(Boolean)
        .join(", ")}`;
    }
    const opLabel =
      action.op === "not_contains"
        ? "does not contain"
        : action.op === "not_equals"
          ? "does not equal"
          : action.op.replace("_", " ");
    return `Add filter: ${action.field} ${opLabel} "${action.value}"`;
  }
  if (action.type === "remove_filter") {
    return "Remove a filter";
  }
  if (action.type === "update_folder_rule") {
    return `Update AI rule: "${action.ai_rule}"`;
  }
  if (action.type === "update_folder_profile") {
    return "Refine the learned profile";
  }
  const parts = describeSettings(action.settings);
  return parts.length ? parts.join(" · ") : "Update folder settings";
}

/** Reduce the approved actions into a patch we can lift into the editor. */
export function settingsToLocalPatch(actions: FolderChatAction[]): Partial<Folder> {
  const patch: Partial<Folder> = {};
  for (const a of actions) {
    if (a.type === "update_folder_rule") patch.ai_rule = a.ai_rule.trim();
    else if (a.type === "update_folder_profile") patch.learned_profile = a.learned_profile.trim();
    else if (a.type === "update_folder_settings") {
      const s = a.settings;
      if (s.name !== undefined) patch.name = s.name.trim();
      if (s.color !== undefined) patch.color = s.color;
      if (s.priority !== undefined) patch.priority = s.priority;
      if (s.auto_archive !== undefined) patch.auto_archive = s.auto_archive;
      if (s.auto_mark_read !== undefined) patch.auto_mark_read = s.auto_mark_read;
      if (s.auto_star !== undefined) patch.auto_star = s.auto_star;
      if (s.hide_from_inbox !== undefined) patch.hide_from_inbox = s.hide_from_inbox;
      if (s.skip_ai !== undefined) patch.skip_ai = s.skip_ai;
      if (s.overrides_inbox_override !== undefined)
        patch.overrides_inbox_override = s.overrides_inbox_override;
      if (s.is_cold_email !== undefined) patch.is_cold_email = s.is_cold_email;
      if (s.forward_to !== undefined) patch.forward_to = s.forward_to;
      if (s.snooze_hours !== undefined) patch.snooze_hours = s.snooze_hours;
      if (s.min_ai_confidence !== undefined) patch.min_ai_confidence = s.min_ai_confidence;
      if (s.filter_logic !== undefined) patch.filter_logic = s.filter_logic;
    }
  }
  return patch;
}
