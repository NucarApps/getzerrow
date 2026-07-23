// Shared server-only helpers used by gmail.functions.ts and its
// sibling files (gmail-diagnostics.functions.ts, and any future split
// files under src/lib/gmail/). RLS doesn't apply to supabaseAdmin
// (service role); each helper enforces user_id ownership.
//
// Anything that lives in more than one `.functions.ts` module — or that
// a `createServerFn` handler needs to call — belongs here so the
// `?tss-serverfn-split` transform never has to hoist sibling helpers.
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getEmailsDecrypted } from "@/lib/sync/encrypted-reader";
import { updateEmailEncrypted } from "@/lib/sync/encrypted-writer";
import { modifyMessage } from "./gmail.server";
import { bulkCatchupClaim } from "./sync.server";
import { CATCHUP_MAX_ROUNDS, CATCHUP_TOTAL_BUDGET_MS } from "./sync/config";
import { logError } from "./log.server";

export async function getOwnedAccount(userId: string, accountId: string) {
  const { data, error } = await supabaseAdmin
    .from("gmail_accounts")
    .select("id, user_id")
    .eq("id", accountId)
    .single();
  if (error || !data) throw new Error("Gmail account not found");
  if (data.user_id !== userId) throw new Error("Not authorized for this account");
  return data;
}

export async function getEmailAccount(userId: string, emailId: string) {
  // Plaintext columns were dropped (Phase 3 encryption); read base metadata
  // from the table and the sensitive fields via the decrypt RPC.
  const { data, error } = await supabaseAdmin
    .from("emails")
    .select("id, gmail_message_id, gmail_account_id, user_id, thread_id, from_addr")
    .eq("id", emailId)
    .single();
  if (error || !data) throw new Error("Email not found");
  if (data.user_id !== userId) throw new Error("Not authorized");

  const { rows } = await getEmailsDecrypted([emailId]);
  const dec = rows[0];
  return {
    gmail_message_id: data.gmail_message_id,
    gmail_account_id: data.gmail_account_id,
    user_id: data.user_id,
    thread_id: data.thread_id,
    from_addr: data.from_addr,
    subject: dec?.subject ?? null,
    body_text: dec?.body_text ?? null,
    from_name: dec?.from_name ?? null,
  };
}

export async function getOwnedFolder(userId: string, folderId: string) {
  const { data, error } = await supabaseAdmin
    .from("folders")
    .select("id, user_id, gmail_account_id")
    .eq("id", folderId)
    .single();
  if (error || !data) throw new Error("Folder not found");
  if (data.user_id !== userId) throw new Error("Not authorized");
  return data;
}

export async function getOwnedSchedule(userId: string, id: string) {
  const { data, error } = await supabaseAdmin
    .from("folder_summary_schedules")
    .select("id, user_id, folder_id, hour, minute, timezone, enabled")
    .eq("id", id)
    .single();
  if (error || !data) throw new Error("Schedule not found");
  if (data.user_id !== userId) throw new Error("Not authorized");
  return data;
}

/**
 * Evict an email from its folder back to the inbox and keep Gmail in sync.
 * Shared by the single-email Re-analyze paths (inbox_override / excluded),
 * the manual "Move to Inbox" action, the bulk reclassify path, and the
 * always-inbox reprocess sweep — all of which used to inline the identical
 * three steps: (1) recompute raw_labels (drop the folder label, add INBOX),
 * (2) updateEmailEncrypted, (3) flip the emails row to folder_id=null /
 * is_archived=false, then (4) best-effort modifyMessage in Gmail.
 *
 * Per-caller variation is expressed via options: `classifiedBy`,
 * `classificationReason`, and the optional `aiConfidence` / `aiSummary`
 * (omit to leave the column untouched — matching each original call site) and
 * the log key used if the Gmail label write fails.
 */
export async function restoreEmailToInbox(opts: {
  emailId: string;
  gmailAccountId: string;
  gmailMessageId: string | null;
  currentLabels: string[];
  /** The moved-from folder's Gmail label id, removed from raw_labels + Gmail. */
  fromLabel: string | null;
  classifiedBy: string;
  classificationReason: string;
  /** Pass to set emails.ai_confidence; omit to leave it unchanged. */
  aiConfidence?: number | null;
  /** Pass to set the encrypted ai_summary; omit to leave it unchanged. */
  aiSummary?: string;
  labelFailureLog: { event: string; payload?: Record<string, unknown> };
}): Promise<void> {
  const nextLabels = Array.from(
    new Set(
      opts.currentLabels.filter((l) => !opts.fromLabel || l !== opts.fromLabel).concat(["INBOX"]),
    ),
  );

  await updateEmailEncrypted({
    email_id: opts.emailId,
    classification_reason: opts.classificationReason,
    ...(opts.aiSummary !== undefined ? { ai_summary: opts.aiSummary } : {}),
  });

  await supabaseAdmin
    .from("emails")
    .update({
      folder_id: null,
      is_archived: false,
      classified_by: opts.classifiedBy,
      ...(opts.aiConfidence !== undefined ? { ai_confidence: opts.aiConfidence } : {}),
      matched_filter_ids: [],
      raw_labels: nextLabels,
    })
    .eq("id", opts.emailId);

  if (opts.gmailMessageId) {
    try {
      await modifyMessage(
        opts.gmailAccountId,
        opts.gmailMessageId,
        ["INBOX"],
        opts.fromLabel ? [opts.fromLabel] : [],
      );
    } catch (e) {
      logError(opts.labelFailureLog.event, opts.labelFailureLog.payload ?? {}, e);
    }
  }
}

export function extractDomain(addr: string | null): string | null {
  if (!addr) return null;
  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  return addr
    .slice(at + 1)
    .toLowerCase()
    .replace(/[>\s]+$/g, "");
}

// IANA timezone identifier validator used by folder-summary schedules.
export const ianaTz = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+\-/]+$/);

// Aggregated result of running several bulk catch-up rounds during a sync.
type CatchupRound = Awaited<ReturnType<typeof bulkCatchupClaim>>;
export type DrainResult = {
  scanned: number;
  inserted: number;
  ai_pending: number;
  fetch_failed: number;
  overflowed: boolean;
  rounds: number;
};

// Drain the message-job queue in bounded rounds so a backlog lands at once
// instead of trickling via the 5s cron lane. Stops when a round claims
// nothing, the queue is no longer overflowing, the round cap is hit, or
// the wall-clock budget is exceeded (keeps the request under the Safari
// "Load failed" wall). Anything left falls back to the cron lane.
export async function drainCatchupRounds(
  accountId: string,
  userId: string,
  logKey: string,
): Promise<DrainResult> {
  const agg: DrainResult = {
    scanned: 0,
    inserted: 0,
    ai_pending: 0,
    fetch_failed: 0,
    overflowed: false,
    rounds: 0,
  };
  const startedAt = Date.now();
  for (let i = 0; i < CATCHUP_MAX_ROUNDS; i++) {
    let round: CatchupRound;
    try {
      round = await bulkCatchupClaim(accountId, userId);
    } catch (e) {
      logError(logKey, { account_id: accountId, user_id: userId }, e);
      break;
    }
    agg.rounds += 1;
    agg.scanned += round.scanned;
    agg.inserted += round.inserted;
    agg.ai_pending += round.ai_pending;
    agg.fetch_failed += round.fetch_failed;
    agg.overflowed = round.overflowed;
    // Nothing left to claim, or queue drained — stop.
    if (round.scanned === 0 || !round.overflowed) break;
    // Respect the wall-clock budget before starting another round.
    if (Date.now() - startedAt > CATCHUP_TOTAL_BUDGET_MS) break;
  }
  return agg;
}
