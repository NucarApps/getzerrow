// Action fan-out for rule-routed email (rules upgrade, task 4).
//
// DESIGN
//   Handlers never call Gmail or the DB themselves — each one contributes
//   to a shared MutationPlan (label adds/removes + an emails-row patch)
//   that the caller (applyFolderActions in process-message.ts) executes as
//   ONE modifyMessage call and ONE row update, exactly like the pre-
//   dispatcher code. That keeps the Gmail API batching, the "no second
//   realtime event" property, and every existing test contract intact.
//
// IDEMPOTENCY
//   Handlers check current state before mutating the plan: archiving an
//   already-archived message, starring a starred one, or re-adding a
//   present label is a no-op reported as status 'skipped'. Running the
//   same action twice therefore never produces a second mutation.
//
// FLAGS AS IMPLICIT ACTIONS (backward compatibility)
//   mergeFlagActions maps the legacy folder flags to synthetic in-memory
//   actions (auto_archive/hide_from_inbox → archive, auto_mark_read →
//   mark_read, auto_star → star, gmail_label_id → label) unless an
//   explicit enabled folder_actions row of that type exists — an explicit
//   row overrides the flag for its action type. snooze_hours and
//   forward_to remain handled by applyFolderActions directly (forward is
//   not dispatched until its action row lands in a later task).
//
// DELAYED ACTIONS
//   An explicit row with delay_minutes > 0 is enqueued into
//   scheduled_actions (status 'pending') instead of running inline. The
//   runner cron lands with the webhook action (task 5); until then the
//   queue only accumulates for folders that configure delays.
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError } from "@/lib/log.server";
import { validateWebhookUrl } from "../webhook/url-guard";
import type { ActionFolder } from "./process-message";

// folder_actions/scheduled_actions are not in the generated Supabase
// types yet — untyped accessor, same pattern as executed-rules.ts.
function adminTable(table: string) {
  return (supabaseAdmin as unknown as SupabaseClient).from(table);
}

/** The folder_actions columns the task-4 handlers need. `id` is null for
 * synthetic (flag-derived) actions. */
export type FolderActionRow = {
  id: string | null;
  action_type: string;
  label_id: string | null;
  move_to_folder_id: string | null;
  delay_minutes: number;
  /** call_webhook only — validated by the SSRF guard before enqueue. */
  webhook_url?: string | null;
  /** send_email only — required; reply/draft derive the recipient. */
  to_addr?: string | null;
};

/** Outbound actions (task 8): always executed by the runner cron so
 * Gmail sends never block the classify hot path. */
export const OUTBOUND_ACTION_TYPES = new Set(["reply", "draft", "send_email"]);

export type MutationPlan = {
  addLabels: string[];
  removeLabels: string[];
  /** Patch for the emails row. Executed by the caller in its single
   * update statement (merged with forward/snooze fields). */
  patch: Record<string, unknown>;
};

export type ActionOutcome = {
  action_type: string;
  folder_action_id: string | null;
  status: "applied" | "skipped" | "error" | "pending";
  error: string | null;
  /** Action configuration only (label ids, target folder) — never email
   * content or AI output. Feeds the executed_actions audit rows. */
  payload: Record<string, unknown> | null;
};

export type DispatchInput = {
  actions: FolderActionRow[];
  parsed: { raw_labels: string[] | null };
  inInbox: boolean;
  /** Mirrors applyFolderActions: false = the INSERT already carried the
   * flag-derived row state, so SYNTHETIC actions skip their patch.
   * Explicit rows always patch — their effects are never in the insert. */
  persistFlags: boolean;
  emailRowId: string;
  /** Required to enqueue delayed actions; without it a delayed action
   * reports an error outcome instead of silently running inline. */
  userId?: string;
  /** Resolver for move_folder targets (Gmail label of the destination). */
  resolveMoveTarget?: (folderId: string) => Promise<{ gmail_label_id: string | null } | null>;
};

function synthetic(action_type: string, over: Partial<FolderActionRow> = {}): FolderActionRow {
  return {
    id: null,
    action_type,
    label_id: null,
    move_to_folder_id: null,
    delay_minutes: 0,
    ...over,
  };
}

/** Map legacy folder flags to synthetic actions, letting explicit enabled
 * rows override the flag for their action type. */
export function mergeFlagActions(
  folder: ActionFolder,
  explicit: FolderActionRow[],
): FolderActionRow[] {
  const have = new Set(explicit.map((a) => a.action_type));
  const out = [...explicit];
  // Synthetic order mirrors the pre-dispatcher computeFolderEffects
  // sequence (label → UNREAD → STARRED → INBOX) so the batched Gmail
  // mutation arrays stay byte-identical for flag-only folders.
  if (folder.gmail_label_id && !have.has("label")) {
    out.push(synthetic("label", { label_id: folder.gmail_label_id }));
  }
  if (folder.auto_mark_read && !have.has("mark_read")) out.push(synthetic("mark_read"));
  if (folder.auto_star && !have.has("star")) out.push(synthetic("star"));
  const effectiveArchive = folder.auto_archive || folder.hide_from_inbox;
  if (effectiveArchive && !have.has("archive")) out.push(synthetic("archive"));
  return out;
}

const pushOnce = (arr: string[], v: string) => {
  if (!arr.includes(v)) arr.push(v);
};

/** Run the implemented action types against the plan. Unimplemented types
 * (reply, send_email, call_webhook, …) yield an 'error' outcome — they
 * land in later tasks — and never break message processing. */
export async function dispatchFolderActions(input: DispatchInput): Promise<{
  plan: MutationPlan;
  outcomes: ActionOutcome[];
}> {
  const plan: MutationPlan = { addLabels: [], removeLabels: [], patch: {} };
  const outcomes: ActionOutcome[] = [];
  const labels = input.parsed.raw_labels ?? [];

  for (const action of input.actions) {
    const isSynthetic = action.id === null;
    const persistPatch = input.persistFlags || !isSynthetic;
    const outcome: ActionOutcome = {
      action_type: action.action_type,
      folder_action_id: action.id,
      status: "applied",
      error: null,
      payload: null,
    };

    const enqueue = async (delayMinutes: number) => {
      if (!input.userId) throw new Error("queued action requires user context");
      const runAt = new Date(Date.now() + delayMinutes * 60_000).toISOString();
      const { error } = await adminTable("scheduled_actions").insert({
        user_id: input.userId,
        folder_action_id: action.id,
        email_id: input.emailRowId,
        run_at: runAt,
      });
      if (error) throw new Error(error.message);
      outcome.status = "pending";
      outcome.payload = { ...(outcome.payload ?? {}), run_at: runAt };
    };

    try {
      // Webhooks always run through the queue (network I/O never blocks
      // the classify hot path); the SSRF guard rejects bad URLs up front.
      if (!isSynthetic && action.action_type === "call_webhook") {
        const guard = validateWebhookUrl(action.webhook_url ?? "");
        if (!guard.ok) throw new Error(guard.reason);
        outcome.payload = { webhook_url: action.webhook_url };
        await enqueue(action.delay_minutes);
        outcomes.push(outcome);
        continue;
      }

      // Outbound email actions (task 8) always run through the queue —
      // sending mail is network I/O that must never block classify. A
      // delay of 0 means "next runner tick" (≤1 minute).
      if (!isSynthetic && OUTBOUND_ACTION_TYPES.has(action.action_type)) {
        if (action.action_type === "send_email" && !(action.to_addr ?? "").trim()) {
          throw new Error("send_email requires a recipient (to_addr)");
        }
        if (action.to_addr) outcome.payload = { to_addr: action.to_addr };
        await enqueue(action.delay_minutes);
        outcomes.push(outcome);
        continue;
      }

      // Delayed explicit actions queue instead of running inline.
      if (!isSynthetic && action.delay_minutes > 0) {
        await enqueue(action.delay_minutes);
        outcomes.push(outcome);
        continue;
      }

      switch (action.action_type) {
        case "archive": {
          if (input.inInbox && !plan.removeLabels.includes("INBOX")) {
            plan.removeLabels.push("INBOX");
            if (persistPatch) plan.patch.is_archived = true;
          } else {
            outcome.status = "skipped";
          }
          break;
        }
        case "mark_read": {
          // Label removal only when UNREAD is actually present; the local
          // is_read patch is a converging write (matches the pre-dispatch
          // behavior, which corrected stale local state).
          let did = false;
          if (labels.includes("UNREAD") && !plan.removeLabels.includes("UNREAD")) {
            plan.removeLabels.push("UNREAD");
            did = true;
          }
          if (persistPatch && plan.patch.is_read !== true) {
            plan.patch.is_read = true;
            did = true;
          }
          if (!did) outcome.status = "skipped";
          break;
        }
        case "star": {
          if (!labels.includes("STARRED") && !plan.addLabels.includes("STARRED")) {
            plan.addLabels.push("STARRED");
          } else {
            outcome.status = "skipped";
          }
          break;
        }
        case "label": {
          const labelId = action.label_id;
          if (!labelId) {
            outcome.status = "skipped";
          } else if (!labels.includes(labelId) && !plan.addLabels.includes(labelId)) {
            plan.addLabels.push(labelId);
            outcome.payload = { label_id: labelId };
          } else {
            outcome.status = "skipped";
          }
          break;
        }
        case "move_folder": {
          const target = action.move_to_folder_id;
          if (!target) {
            outcome.status = "skipped";
            break;
          }
          if (plan.patch.folder_id === target) {
            outcome.status = "skipped";
            break;
          }
          plan.patch.folder_id = target;
          outcome.payload = { move_to_folder_id: target };
          const resolved = input.resolveMoveTarget ? await input.resolveMoveTarget(target) : null;
          if (resolved?.gmail_label_id) pushOnce(plan.addLabels, resolved.gmail_label_id);
          break;
        }
        default:
          throw new Error(`action not implemented: ${action.action_type}`);
      }
    } catch (e) {
      outcome.status = "error";
      outcome.error = (e as Error)?.message?.slice(0, 300) ?? "unknown";
      // Metadata only — action failures must never break mail processing.
      logError(
        "action_dispatch.failed",
        {
          action_type: action.action_type,
          folder_action_id: action.id,
          email_id: input.emailRowId,
        },
        e,
      );
    }
    outcomes.push(outcome);
  }

  return { plan, outcomes };
}
