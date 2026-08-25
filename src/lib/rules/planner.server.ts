// Server-only helpers behind the rule planner (Phase D).
//
// Two jobs:
//   * assemble the engine's inputs for one account plus a candidate rule,
//     so the collision checker and the replay share one snapshot
//   * load the message window the checks run over, decrypted
//
// The window is capped and the load path mirrors the simulator's: ids come
// from the RLS-scoped client, so the admin decrypt only ever sees the
// caller's own mail.
import type { SupabaseClient } from "@supabase/supabase-js";
import { emailDomain } from "../company-domains";
import { loadAccountContext } from "../sync/account-context";
import { getEmailsDecrypted } from "../sync/encrypted-reader";
import { toEngineFolder, toGuardrails, toPins, toRules } from "./adapt";
import type { EvaluateContext, Rule } from "./types";
import type { ReplayMessage } from "./replay";

/** Trailing window the save-time checks and the replay both use. */
export const REPLAY_WINDOW_DAYS = 90;
/** Hard cap on messages scanned per check. Keeps the request bounded. */
export const REPLAY_MESSAGE_CAP = 1000;

export type PlannerSnapshot = {
  /** Engine context WITHOUT the candidate rule. */
  context: EvaluateContext;
  /** Existing rules, adapted from folder_filters and filter trees. */
  rules: Rule[];
  messages: ReplayMessage[];
};

/** Build the engine snapshot for one account over the replay window. */
export async function loadPlannerSnapshot(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<PlannerSnapshot> {
  const ctx = await loadAccountContext(accountId, userId);
  const folders = ctx.folders.map(toEngineFolder);
  const rules = toRules(ctx.folders, ctx.filters);
  const guardrails = toGuardrails(ctx.filters);
  const pins = toPins(ctx.overrides);

  const days = opts.days ?? REPLAY_WINDOW_DAYS;
  const limit = Math.min(opts.limit ?? REPLAY_MESSAGE_CAP, REPLAY_MESSAGE_CAP);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data: rows, error } = await supabase
    .from("emails")
    .select(
      "id, folder_id, has_attachment, received_at, thread_id, raw_labels, placed_by_user, decision_confirmed_at",
    )
    .eq("gmail_account_id", accountId)
    .gte("received_at", cutoff)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const ids = (rows ?? []).map((r) => r.id);
  const messages: ReplayMessage[] = [];
  if (ids.length) {
    const { rows: decrypted, error: decErr } = await getEmailsDecrypted(ids);
    if (decErr) throw new Error(decErr);
    const byId = new Map(decrypted.map((d) => [d.id, d]));
    for (const r of rows ?? []) {
      const d = byId.get(r.id);
      if (!d) continue;
      const from = (d.from_addr ?? "").toLowerCase();
      const groups = ctx.senderGroups.get(from);
      messages.push({
        id: r.id,
        folder_id: r.folder_id ?? null,
        received_at: r.received_at ?? null,
        thread_id: r.thread_id ?? null,
        raw_labels: (r.raw_labels ?? []) as string[],
        placed_by_user: r.placed_by_user ?? false,
        decision_confirmed_at: r.decision_confirmed_at ?? null,
        from_addr: d.from_addr ?? "",
        from_name: d.from_name ?? "",
        to_addrs: d.to_addrs ?? "",
        cc: d.cc ?? undefined,
        subject: d.subject ?? "",
        body_text: d.body_text ?? "",
        has_attachment: !!r.has_attachment,
        sender_group_ids: groups ? Array.from(groups) : [],
      });
    }
  }

  return {
    context: { folders, rules, pins, guardrails },
    rules,
    messages,
  };
}

/** Overlay the candidate onto the snapshot: an edit replaces the rule it
 * came from, a new rule is appended, a disable drops it. */
export function withCandidate(
  snapshot: PlannerSnapshot,
  candidate: Rule | null,
  replacedRuleIds: string[],
): EvaluateContext {
  const dropped = new Set(replacedRuleIds);
  const rules = snapshot.rules.filter((r) => !dropped.has(r.id) && r.id !== candidate?.id);
  return { ...snapshot.context, rules: candidate ? [...rules, candidate] : rules };
}

/** Sender domain of a message, for the editor's chip suggestions. */
export const senderDomain = (addr: string | null | undefined): string =>
  emailDomain(addr ?? "") ?? "";
