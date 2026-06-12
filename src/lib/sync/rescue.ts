// Stranded-email rescue sweep. Last-resort net for emails whose
// classification never completed: AI gateway outages, workers killed
// mid-job, jobs that exhausted their queue retries, or rows from
// before the retry machinery existed.
//
// Eligibility: folder_id IS NULL, classified_by in a non-terminal
// state, arrived within RESCUE_WINDOW_HOURS, fewer than
// RESCUE_MAX_ATTEMPTS sweep attempts. Emails with a live message_jobs
// row are skipped — the queue's own retry path owns those.
//
// Per account: rules first (catches filters/folders the user created
// AFTER the mail arrived — the most common reason mail looks
// "stranded"), then batched AI with per-message fallback. Rows that
// exhaust the attempt cap go terminal as classified_by='unclassified'
// and stay visible in Inbox — the correct failure mode.
//
// Scheduled via pg_cron every 10 minutes → /api/public/gmail-rescue-classify.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { classifyEmail, classifyEmailsBatch } from "../ai.server";
import { loadAccountContext, type AccountContext } from "./account-context";
import { classifyByRules, type ParsedEmailForClassify } from "./classify";
import { applyFolderActions, type ActionFolder } from "./process-message";
import { bumpEmailsSinceLearn } from "./folder-learn";
import { RESCUE_WINDOW_HOURS, RESCUE_MAX_ATTEMPTS, RESCUE_BATCH_LIMIT, RESCUE_AI_BATCH_SIZE } from "./config";

const NON_TERMINAL_STATES = ["pending", "pending_ai", "unclassified", "ai_error"] as const;

type RescueRow = {
  id: string;
  user_id: string;
  gmail_account_id: string;
  gmail_message_id: string;
  from_addr: string | null;
  from_name: string | null;
  to_addrs: string | null;
  cc: string | null;
  list_id: string | null;
  in_reply_to: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  has_attachment: boolean | null;
  received_at: string | null;
  raw_labels: string[] | null;
  classify_attempts: number | null;
};

function toParsed(row: RescueRow): ParsedEmailForClassify {
  return {
    from_addr: row.from_addr ?? "",
    from_name: row.from_name ?? "",
    to_addrs: row.to_addrs ?? "",
    cc: row.cc ?? undefined,
    list_id: row.list_id ?? undefined,
    in_reply_to: row.in_reply_to ?? undefined,
    subject: row.subject ?? "",
    snippet: row.snippet ?? "",
    body_text: row.body_text ?? "",
    body_html: "",
    has_attachment: row.has_attachment ?? false,
    received_at: row.received_at ?? new Date().toISOString(),
    raw_labels: row.raw_labels,
  };
}

function actionParsed(row: RescueRow) {
  return {
    raw_labels: row.raw_labels,
    subject: row.subject ?? "",
    from_addr: row.from_addr ?? "",
    from_name: row.from_name ?? "",
    received_at: row.received_at ?? new Date().toISOString(),
    body_text: row.body_text ?? "",
    snippet: row.snippet ?? "",
  };
}

async function finalize(
  row: RescueRow,
  ctx: AccountContext,
  outcome: {
    folder_id: string | null;
    classified_by: string;
    ai_confidence: number;
    ai_summary: string;
    classification_reason: string | null;
    matched_filter_ids?: string[];
    matched_folder_ids?: string[];
  },
) {
  await supabaseAdmin.from("emails").update({
    folder_id: outcome.folder_id,
    ai_summary: outcome.ai_summary || null,
    ai_confidence: outcome.ai_confidence,
    classified_by: outcome.classified_by,
    classification_reason: outcome.classification_reason,
    ...(outcome.matched_filter_ids ? { matched_filter_ids: outcome.matched_filter_ids } : {}),
    ...(outcome.matched_folder_ids ? { matched_folder_ids: outcome.matched_folder_ids } : {}),
  }).eq("id", row.id);
  if (outcome.folder_id) {
    void bumpEmailsSinceLearn(outcome.folder_id);
    const cached = ctx.folders.find((f) => f.id === outcome.folder_id);
    const folder: ActionFolder | null = cached
      ? {
          id: cached.id,
          gmail_label_id: cached.gmail_label_id,
          auto_archive: cached.auto_archive,
          auto_mark_read: cached.auto_mark_read,
          auto_star: cached.auto_star,
          hide_from_inbox: cached.hide_from_inbox,
          forward_to: cached.forward_to,
          snooze_hours: cached.snooze_hours,
        }
      : null;
    if (folder) {
      const inInbox = (row.raw_labels ?? []).includes("INBOX");
      await applyFolderActions(
        row.gmail_account_id, row.gmail_message_id, row.id, folder, actionParsed(row), inInbox,
        { persistFlags: true },
      );
    }
  }
}

/** When a rescue attempt fails: leave the row eligible for the next
 * sweep, or go terminal once the attempt cap is reached. */
async function recordFailure(row: RescueRow, attemptNumber: number, errMsg: string) {
  const terminal = attemptNumber >= RESCUE_MAX_ATTEMPTS;
  await supabaseAdmin.from("emails").update({
    classified_by: terminal ? "unclassified" : "pending_ai",
    classification_reason: terminal
      ? `Classification failed after ${attemptNumber} rescue attempts: ${errMsg.slice(0, 150)}`
      : `Rescue attempt ${attemptNumber} failed (will retry): ${errMsg.slice(0, 150)}`,
  }).eq("id", row.id);
}

export async function rescueStrandedEmails(opts: { limit?: number } = {}) {
  const limit = opts.limit ?? RESCUE_BATCH_LIMIT;
  const since = new Date(Date.now() - RESCUE_WINDOW_HOURS * 3600_000).toISOString();

  // emails_decrypted gives plaintext body_text for AI quality — the
  // base table's body_text is zeroed by the encryption trigger.
  const { data: rows, error } = await supabaseAdmin
    .from("emails_decrypted")
    .select("id, user_id, gmail_account_id, gmail_message_id, from_addr, from_name, to_addrs, cc, list_id, in_reply_to, subject, snippet, body_text, has_attachment, received_at, raw_labels, classify_attempts")
    .is("folder_id", null)
    .in("classified_by", NON_TERMINAL_STATES as unknown as string[])
    .gte("created_at", since)
    .lt("classify_attempts", RESCUE_MAX_ATTEMPTS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    // classify_attempts not deployed yet → the view lacks the column.
    // Report instead of crashing the cron.
    console.error("rescue select failed (migration applied?)", error.message);
    return { scanned: 0, rescued: 0, failed: 0, skipped: 0, error: error.message };
  }
  const candidates = (rows ?? []) as RescueRow[];
  if (candidates.length === 0) return { scanned: 0, rescued: 0, failed: 0, skipped: 0 };

  // Skip emails the queue still owns — its retry path will classify
  // them; double-running races the worker.
  const accountIds = Array.from(new Set(candidates.map((r) => r.gmail_account_id)));
  const { data: liveJobs } = await supabaseAdmin
    .from("message_jobs")
    .select("gmail_account_id, gmail_message_id")
    .in("gmail_account_id", accountIds)
    .in("status", ["pending", "running"]);
  const owned = new Set((liveJobs ?? []).map((j) => `${j.gmail_account_id}:${j.gmail_message_id}`));
  const eligible = candidates.filter((r) => !owned.has(`${r.gmail_account_id}:${r.gmail_message_id}`));
  const skipped = candidates.length - eligible.length;
  if (eligible.length === 0) return { scanned: candidates.length, rescued: 0, failed: 0, skipped };

  // Bump attempts up-front so a crash mid-sweep still counts.
  const attemptByRow = new Map<string, number>();
  await Promise.all(
    eligible.map(async (r) => {
      const next = (r.classify_attempts ?? 0) + 1;
      attemptByRow.set(r.id, next);
      await supabaseAdmin.from("emails").update({ classify_attempts: next }).eq("id", r.id);
    }),
  );

  let rescued = 0;
  let failed = 0;

  const byAccount = new Map<string, RescueRow[]>();
  for (const r of eligible) {
    if (!byAccount.has(r.gmail_account_id)) byAccount.set(r.gmail_account_id, []);
    byAccount.get(r.gmail_account_id)!.push(r);
  }

  for (const [accountId, accountRows] of byAccount) {
    let ctx: AccountContext;
    try {
      ctx = await loadAccountContext(accountId, accountRows[0].user_id);
    } catch (e) {
      console.error("rescue loadAccountContext failed", accountId, e);
      failed += accountRows.length;
      continue;
    }

    // Pass 1: rules. Catches filters/folders created after arrival.
    const needAi: RescueRow[] = [];
    for (const row of accountRows) {
      try {
        const rules = classifyByRules(toParsed(row), ctx);
        if (rules.needs_ai) {
          needAi.push(row);
          continue;
        }
        // Terminal rules outcome (match, excluded, global_exclude, or
        // nothing for AI to do).
        await finalize(row, ctx, rules);
        rescued++;
      } catch (e) {
        failed++;
        await recordFailure(row, attemptByRow.get(row.id) ?? 1, (e as Error)?.message ?? "unknown");
      }
    }

    // Pass 2: batched AI with per-message fallback.
    const fallbackOne = async (row: RescueRow) => {
      try {
        const single = await classifyEmail(toParsed(row), ctx.enrichedFolders);
        await finalize(row, ctx, {
          folder_id: single.folder_id,
          classified_by: "ai",
          ai_confidence: single.confidence,
          ai_summary: single.summary,
          classification_reason: single.reason || null,
        });
        rescued++;
      } catch (e) {
        failed++;
        await recordFailure(row, attemptByRow.get(row.id) ?? 1, (e as Error)?.message ?? "unknown");
      }
    };

    // needs_ai=true guarantees AI-eligible folders exist, so the batch
    // always has candidates.
    for (let i = 0; i < needAi.length; i += RESCUE_AI_BATCH_SIZE) {
      const chunk = needAi.slice(i, i + RESCUE_AI_BATCH_SIZE);
      try {
        const out = await classifyEmailsBatch(chunk.map((r) => toParsed(r)), ctx.enrichedFolders);
        for (let idx = 0; idx < chunk.length; idx++) {
          const row = chunk[idx];
          const r = out[idx];
          if (!r) {
            await fallbackOne(row);
            continue;
          }
          // Same min_ai_confidence gating as the live + backfill paths.
          const candidate = r.folder_id ? ctx.folders.find((f) => f.id === r.folder_id) : null;
          const threshold = candidate?.min_ai_confidence ?? 0;
          const passes = Boolean(r.folder_id && (r.confidence ?? 0) >= threshold);
          await finalize(row, ctx, {
            folder_id: passes ? r.folder_id : null,
            classified_by: passes ? "ai" : (r.folder_id ? "ai_low_confidence" : "ai"),
            ai_confidence: r.confidence ?? 0,
            ai_summary: r.summary ?? "",
            classification_reason: passes
              ? (r.reason || null)
              : (r.folder_id
                  ? `AI suggested "${candidate?.name ?? "?"}" at ${((r.confidence ?? 0) * 100).toFixed(0)}% < min ${(threshold * 100).toFixed(0)}%`
                  : (r.reason || null)),
          });
          rescued++;
        }
      } catch (e) {
        console.error("rescue batch AI failed, falling back per-message", (e as Error)?.message ?? e);
        for (const row of chunk) await fallbackOne(row);
      }
    }
  }

  return { scanned: candidates.length, rescued, failed, skipped };
}
