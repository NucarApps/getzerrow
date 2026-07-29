// Pure logic for per-folder auto mark-read scoping. No Supabase imports so
// it stays trivially testable and safe to import from the filter path.

import { effectiveSender } from "../gmail/origin-sender";

export type MarkReadMode = "all" | "except" | "only";

/** One sender/domain entry attached to a folder's mark-read scope. */
export type MarkReadRule = {
  folder_id: string;
  match_type: "email" | "domain";
  value: string;
};

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/^@/, "");
}

function senderDomain(sender: string): string {
  const at = sender.lastIndexOf("@");
  return at === -1 ? "" : sender.slice(at + 1);
}

/** True when the sender matches any entry in the list. Domain entries also
 * match subdomains (`kenect.com` matches `mail.kenect.com`). */
export function matchesMarkReadRules(rules: MarkReadRule[], sender: string): boolean {
  const addr = normalize(sender);
  if (!addr) return false;
  const domain = senderDomain(addr);
  return rules.some((rule) => {
    const value = normalize(rule.value);
    if (!value) return false;
    if (rule.match_type === "email") return value === addr;
    return domain === value || domain.endsWith(`.${value}`);
  });
}

/** Resolve whether auto mark-read applies to this specific message.
 *
 * - `all`: the folder's `auto_mark_read` flag as-is.
 * - `except`: mark read unless the sender is listed.
 * - `only`: mark read only when the sender is listed.
 *
 * Matching uses the effective sender, so auto-forwarded mail is judged by
 * the original sender rather than the forwarding mailbox. */
export function resolveAutoMarkRead(
  folder: { auto_mark_read: boolean; mark_read_mode?: MarkReadMode | string | null },
  rules: MarkReadRule[],
  email: { from_addr?: string | null; origin_addr?: string | null } | string | null,
): boolean {
  if (!folder.auto_mark_read) return false;
  const mode = (folder.mark_read_mode ?? "all") as MarkReadMode;
  if (mode !== "except" && mode !== "only") return true;

  const sender = typeof email === "string" ? email : email ? effectiveSender(email) : "";
  const listed = matchesMarkReadRules(rules, sender);
  return mode === "except" ? !listed : listed;
}

/** Narrow a full rule list to one folder. */
export function rulesForFolder(rules: MarkReadRule[], folderId: string): MarkReadRule[] {
  return rules.filter((r) => r.folder_id === folderId);
}

/** Current mark-read scope of a folder, as stored on the folder row. */
export type MarkReadScope = {
  auto_mark_read: boolean;
  mark_read_mode: MarkReadMode;
  /** True when this specific sender/domain is already in the folder's list. */
  listed: boolean;
};

/** What a single sender/domain entry should become after the user picks
 * "mark read" or "leave unread" for it in the filter drawer.
 *
 * `listed` describes membership of the folder's sender/domain list, whose
 * meaning flips with the mode: under `except` it is an exemption, under
 * `only` it is an inclusion. */
export function nextMarkReadScope(current: MarkReadScope, markRead: boolean): MarkReadScope {
  const mode: MarkReadMode = current.auto_mark_read ? current.mark_read_mode : "all";

  if (!current.auto_mark_read) {
    // Folder does not auto mark-read at all. Turning it on for one sender must
    // not silently start marking everything else read, hence "only".
    return markRead
      ? { auto_mark_read: true, mark_read_mode: "only", listed: true }
      : { auto_mark_read: false, mark_read_mode: current.mark_read_mode, listed: false };
  }

  if (mode === "all") {
    return markRead
      ? { auto_mark_read: true, mark_read_mode: "all", listed: false }
      : { auto_mark_read: true, mark_read_mode: "except", listed: true };
  }

  if (mode === "except") {
    // The list holds exemptions: being listed means "leave unread".
    return { auto_mark_read: true, mark_read_mode: "except", listed: !markRead };
  }

  // "only": the list holds the senders that DO get marked read.
  return { auto_mark_read: true, mark_read_mode: "only", listed: markRead };
}
