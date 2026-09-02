// The "why is this email in this folder?" explanation shown in a folder's
// history panel.
//
// Deciding what to say is separate from saying it: the panel renders the
// structures below, and everything that has to be right — which of the
// folder's rules is named as the cause, what happens when that rule has since
// been deleted, and which badge a `classified_by` value earns — is decided
// here where it can be tested.

import { EXCLUDE_OPS, matchesLeaf } from "@/lib/sync/filter-engine";
import type { Filter, HistoryEmail } from "@/components/folders/editor/types";

export type ReasonTone = "ai" | "manual" | "rule" | "label" | "muted";

export type ReasonMeta = { label: string; tone: ReasonTone };

/** Badge copy per `classified_by` value. */
export const REASON_META: Record<string, ReasonMeta> = {
  ai: { label: "AI", tone: "ai" },
  manual_move: { label: "Manual", tone: "manual" },
  filter: { label: "Rule", tone: "rule" },
  domain_rule: { label: "Domain rule", tone: "rule" },
  gmail_label: { label: "Gmail label", tone: "label" },
  surfaced_to_inbox: { label: "Surfaced", tone: "label" },
  none: { label: "Imported", tone: "muted" },
};

const NONE_REASON = REASON_META.none!;

/** The badge for a `classified_by`, falling back to "Imported" for anything
 * this panel has no vocabulary for (including a null — an email that was
 * imported alongside the folder itself).
 *
 * The own-property check matters: a plain object record answers
 * `"constructor"` (and every other `Object.prototype` key) with an inherited
 * value, which is truthy, so `?? fallback` would hand the panel a function
 * where it expects `{ label, tone }`. */
export function getReasonMeta(by: string | null | undefined): ReasonMeta {
  const key = by ?? "none";
  return Object.hasOwn(REASON_META, key) ? (REASON_META[key] ?? NONE_REASON) : NONE_REASON;
}

/**
 * Which of a folder's rules explains this message. Delegates to the engine's
 * own leaf matcher so the explanation cannot disagree with what actually
 * filed the mail; `snippet` stands in for the body, which the history panel
 * does not load.
 *
 * Exclude-op rules are skipped, the way the engine partitions a folder's
 * rules: an exclude only ever vetoes a candidate, and it evaluates true for
 * exactly the mail it does NOT veto, so naming one would report the rule the
 * email merely survived instead of the rule that filed it.
 *
 * Returns null when no current include rule matches — which is the normal
 * outcome for an email filed by a rule the user has since deleted, since the
 * panel only ever sees the folder's rules as they are now.
 */
export function matchFilter(email: HistoryEmail, filters: Filter[]): Filter | null {
  for (const f of filters) {
    if (!f.value) continue;
    if (EXCLUDE_OPS.has(f.op)) continue;
    const hit = matchesLeaf(
      {
        from_addr: email.from_addr ?? "",
        from_name: email.from_name ?? "",
        subject: email.subject ?? "",
        body_text: email.snippet ?? "",
      },
      { field: f.field === "snippet" ? "body" : f.field, op: f.op || "contains", value: f.value },
    );
    if (hit) return f;
  }
  return null;
}

/** The expanded explanation: a title, and a body the panel knows how to draw. */
export type ReasonExplanation = {
  title: string;
  body:
    | { kind: "ai_summary"; summary: string }
    | { kind: "ai_no_reason" }
    | { kind: "manual" }
    | { kind: "rule_matched"; filter: Filter }
    | { kind: "rule_unnamed" }
    | { kind: "gmail_label" }
    | { kind: "surfaced" }
    | { kind: "imported" };
};

export function describeReason(email: HistoryEmail, filters: Filter[]): ReasonExplanation {
  const by = email.classified_by ?? "none";

  if (by === "ai") {
    const conf = email.ai_confidence != null ? Math.round(email.ai_confidence * 100) : null;
    return {
      title: `Classified by AI${conf != null ? ` · ${conf}% confidence` : ""}`,
      body: email.ai_summary
        ? { kind: "ai_summary", summary: email.ai_summary }
        : { kind: "ai_no_reason" },
    };
  }
  if (by === "manual_move") {
    return { title: "Moved here manually", body: { kind: "manual" } };
  }
  if (by === "filter" || by === "domain_rule") {
    const matched = matchFilter(email, filters);
    return {
      title: by === "domain_rule" ? "Matched a domain rule" : "Matched a folder rule",
      body: matched ? { kind: "rule_matched", filter: matched } : { kind: "rule_unnamed" },
    };
  }
  if (by === "gmail_label") {
    return { title: "Imported from Gmail label", body: { kind: "gmail_label" } };
  }
  // Surfacing never undoes the filing: the folder's rules routed the email
  // here, then the folder's surface-to-inbox rule judged it worth seeing and
  // put INBOX back on the message. It is in both places on purpose, so the
  // explanation says so rather than naming a rule as the sole cause.
  if (by === "surfaced_to_inbox") {
    return {
      title: "Kept in your inbox by this folder's surface rule",
      body: { kind: "surfaced" },
    };
  }
  return { title: "Imported with this folder", body: { kind: "imported" } };
}

/**
 * The history panel's own relative-time vocabulary ("just now", then minutes,
 * hours and days, then an absolute date past a week). Deliberately not
 * `format.ts`'s `formatRelativeTime`, which speaks a compact seconds-first
 * dialect with no date fallback.
 */
export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const d = new Date(iso).getTime();
  const diff = now - d;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
