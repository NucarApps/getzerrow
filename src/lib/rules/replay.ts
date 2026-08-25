// Replay change-sets (Amendment 4, Phase D).
//
// Every rule create, edit or disable is replayed over a window of recent
// mail so the user sees the consequence BEFORE it happens: "affects 14 —
// 12 Inbox -> Receipts, 2 Receipts -> Inbox". Nothing moves until they
// apply it.
//
// Two safety invariants:
//   * hand-placed mail never moves — a message the user filed themselves
//     is reported as "kept" and can't be applied.
//   * moving a message OUT of a confirmed placement is flagged
//     requires_review and is excluded from Apply All.
//
// The AI stage is always off here (Amendment 1): a replay must be
// reproducible, and an AI call per historical message is neither.
//
// PURE: no Supabase, no AI, no clock.
import { evaluate } from "./evaluate";
import type { EvaluateContext, EngineMessage, Trigger } from "./types";

export type ReplayMessage = EngineMessage & {
  id: string;
  received_at?: string | null;
  /** Where the message sits today. null = Inbox. */
  folder_id: string | null;
  /** The user filed this by hand. */
  placed_by_user?: boolean | null;
  /** The user confirmed the current placement is correct. */
  decision_confirmed_at?: string | null;
};

export type ChangeAction = "move" | "keep";

export type ChangeEntry = {
  email_id: string;
  subject: string | null;
  from_addr: string | null;
  received_at: string | null;
  action: ChangeAction;
  from_folder_id: string | null;
  from_folder_name: string;
  to_folder_id: string | null;
  to_folder_name: string;
  /** Why the engine reached this destination. */
  reason: string;
  /** Excluded from Apply All: it moves mail out of a confirmed placement. */
  requires_review: boolean;
  /** True when the message can't move at all (hand-placed). */
  locked: boolean;
};

export type ChangeSet = {
  entries: ChangeEntry[];
  /** Movable entries only (locked ones excluded). */
  move_count: number;
  requires_review_count: number;
  locked_count: number;
  scanned: number;
  /** "12 Inbox → Receipts, 2 Receipts → Inbox" style breakdown. */
  summary: Array<{ from: string; to: string; count: number }>;
};

export const INBOX_LABEL = "Inbox";

/** Replay the engine over a message window and diff against where each
 * message sits today. Only differences are returned. */
export function buildChangeSet(
  messages: ReplayMessage[],
  context: EvaluateContext,
  opts: { trigger?: Trigger } = {},
): ChangeSet {
  const nameOf = (id: string | null) =>
    id ? (context.folders.find((f) => f.id === id)?.name ?? "folder") : INBOX_LABEL;

  const entries: ChangeEntry[] = [];

  for (const m of messages) {
    const result = evaluate(m, context, {
      trigger: opts.trigger ?? "replay",
      aiEnabled: false,
      skipGmailLabelMatch: true,
    });
    if (result.folder_id === m.folder_id) continue;

    const locked = m.placed_by_user === true;
    const leavingConfirmed = !!m.decision_confirmed_at && m.folder_id !== null;

    entries.push({
      email_id: m.id,
      subject: m.subject ?? null,
      from_addr: m.from_addr ?? null,
      received_at: m.received_at ?? null,
      action: locked ? "keep" : "move",
      from_folder_id: m.folder_id,
      from_folder_name: nameOf(m.folder_id),
      to_folder_id: locked ? m.folder_id : result.folder_id,
      to_folder_name: locked ? nameOf(m.folder_id) : nameOf(result.folder_id),
      reason: locked ? "You filed this message yourself, so it stays put." : result.reason,
      requires_review: !locked && leavingConfirmed,
      locked,
    });
  }

  const movable = entries.filter((e) => !e.locked);
  const counts = new Map<string, { from: string; to: string; count: number }>();
  for (const e of movable) {
    const key = `${e.from_folder_name}\u0000${e.to_folder_name}`;
    const row = counts.get(key);
    if (row) row.count += 1;
    else counts.set(key, { from: e.from_folder_name, to: e.to_folder_name, count: 1 });
  }

  return {
    entries,
    move_count: movable.length,
    requires_review_count: movable.filter((e) => e.requires_review).length,
    locked_count: entries.length - movable.length,
    scanned: messages.length,
    summary: [...counts.values()].sort((a, b) => b.count - a.count),
  };
}

/** The ids Apply All may touch: movable and not flagged for review. */
export function autoApplicableIds(set: ChangeSet): string[] {
  return set.entries.filter((e) => !e.locked && !e.requires_review).map((e) => e.email_id);
}

/** One-line headline for the change-set dialog and the live preview. */
export function describeChangeSet(set: ChangeSet): string {
  if (set.move_count === 0) return "No existing mail changes folders.";
  const parts = set.summary.slice(0, 3).map((s) => `${s.count} ${s.from} → ${s.to}`);
  const rest = set.summary.length > 3 ? `, +${set.summary.length - 3} more` : "";
  return `Affects ${set.move_count}: ${parts.join(", ")}${rest}`;
}
