// Synchronous "catch-up" bulk processing for the manual-sync path.
//
// PROBLEM
//   The default flow is fire-and-forget: syncSinceHistory enqueues N
//   message_jobs rows, returns. The cron lane (every 5s) then drains
//   them one-by-one, each INSERT producing a separate realtime event
//   and a separate React render — the user sees emails trickle in over
//   several seconds.
//
// THIS PATH
//   When the user opens the app, triggerSync runs after enqueue and
//   synchronously claims up to CATCHUP_BULK_LIMIT jobs, fetches them in
//   parallel, classifies by rules, and INSERTS THEM ALL IN ONE
//   STATEMENT. The client's refetchQueries(["emails"]) then sees every
//   new email at once — no trickle.
//
//   Mail that needs AI is inserted as classified_by='pending_ai' and
//   the job row is reset to 'pending' so the live cron lane picks it up
//   for the AI pass. processGmailMessage's pending-reclassify branch
//   re-runs classification on the existing row when the retry job
//   lands, so no double-insert.
//
//   Anything past CATCHUP_BULK_LIMIT is left in the queue and the
//   existing cron lane drains it as today — that long tail still
//   trickles, but the front-of-list mail the user actually looks at is
//   instant.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMessage, parseMessage } from "../gmail.server";
import { logError } from "../log.server";
import { loadAccountContext, type AccountContext } from "./account-context";
import { classifyByRules } from "./classify";
import { applyFolderActions, type ActionFolder } from "./process-message";
import { bumpEmailsSinceLearn } from "./folder-learn";
import { CATCHUP_BULK_LIMIT, CATCHUP_FETCH_CONCURRENCY } from "./config";
import {
  upsertEmailEncrypted,
  updateEmailEncrypted,
  type UpsertEmailInput,
  type UpdateEmailInput,
} from "./encrypted-writer";

type ClaimedJob = {
  id: string;
  gmail_account_id: string;
  gmail_message_id: string;
  user_id: string;
  attempt: number;
  priority: number;
  published_at_ms: number | null;
};

type Parsed = ReturnType<typeof parseMessage>;

async function parallelFetch(
  accountId: string,
  jobs: ClaimedJob[],
  concurrency: number,
): Promise<Array<{ job: ClaimedJob; parsed: Parsed | null; error?: string }>> {
  const out: Array<{ job: ClaimedJob; parsed: Parsed | null; error?: string }> = jobs.map((j) => ({
    job: j,
    parsed: null,
  }));
  const queue = jobs.map((_, i) => i);
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const idx = queue.shift();
      if (idx === undefined) return;
      const job = jobs[idx];
      try {
        const raw = await getMessage(accountId, job.gmail_message_id);
        out[idx].parsed = parseMessage(raw);
      } catch (e) {
        out[idx].error = (e as Error)?.message ?? "fetch failed";
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function resolveActionFolder(ctx: AccountContext, folderId: string): ActionFolder | null {
  const cached = ctx.folders.find((f) => f.id === folderId);
  if (!cached) return null;
  return {
    id: cached.id,
    gmail_label_id: cached.gmail_label_id,
    auto_archive: cached.auto_archive,
    auto_mark_read: cached.auto_mark_read,
    auto_star: cached.auto_star,
    hide_from_inbox: cached.hide_from_inbox,
    forward_to: cached.forward_to,
    snooze_hours: cached.snooze_hours,
  };
}

/** Build the encrypted-write payload for one parsed message. Mirrors the
 * single-row write in processGmailMessage so the two paths produce
 * indistinguishable results — same fields, same flag computation. Sensitive
 * columns are encrypted at rest via the upsert/update RPCs (Phase 3), so we
 * never write plaintext columns directly.
 * Exported for unit-testability. */
export type CatchupBuilt = {
  upsert: UpsertEmailInput;
  update: UpdateEmailInput | null;
  snoozed_until: string | null;
  needs_ai: boolean;
  folder_id: string | null;
};

export function buildCatchupRow(
  job: ClaimedJob,
  parsed: Parsed,
  ctx: AccountContext,
): CatchupBuilt | null {
  const labels = parsed.raw_labels ?? [];
  const EXCLUDED_LABELS = ["SENT", "DRAFT", "TRASH", "SPAM", "CHAT"];
  if (EXCLUDED_LABELS.some((l) => labels.includes(l))) return null;
  const inInbox = labels.includes("INBOX");

  const rules = classifyByRules(parsed, ctx);
  const baseUpsert: UpsertEmailInput = {
    user_id: job.user_id,
    gmail_account_id: job.gmail_account_id,
    gmail_message_id: parsed.gmail_message_id,
    thread_id: parsed.thread_id,
    from_addr: parsed.from_addr,
    from_name: parsed.from_name,
    to_addrs: parsed.to_addrs,
    cc: parsed.cc || null,
    list_id: parsed.list_id || null,
    in_reply_to: parsed.in_reply_to || null,
    subject: parsed.subject,
    snippet: parsed.snippet,
    body_text: parsed.body_text,
    body_html: parsed.body_html,
    received_at: parsed.received_at,
    is_read: parsed.is_read,
    is_archived: !inInbox,
    has_attachment: parsed.has_attachment,
    raw_labels: parsed.raw_labels,
    classified_by: "pending_ai",
    processed_at: new Date().toISOString(),
    published_at_ms: job.published_at_ms,
  };

  if (rules.needs_ai) {
    return {
      upsert: baseUpsert,
      update: null,
      snoozed_until: null,
      needs_ai: true,
      folder_id: null,
    };
  }

  // Rules-final: compute folder effects so is_archived / is_read /
  // snoozed_until match what processGmailMessage would produce.
  let archived = !inInbox;
  let read = parsed.is_read;
  let snoozedUntil: string | null = null;
  if (rules.folder_id) {
    const folder = resolveActionFolder(ctx, rules.folder_id);
    if (folder) {
      const effectiveArchive = folder.auto_archive || folder.hide_from_inbox;
      if (inInbox && effectiveArchive) archived = true;
      if (folder.auto_mark_read) read = true;
      if (folder.snooze_hours && folder.snooze_hours > 0) {
        snoozedUntil = new Date(Date.now() + folder.snooze_hours * 3600_000).toISOString();
      }
    }
  }
  return {
    upsert: {
      ...baseUpsert,
      classified_by: rules.classified_by,
      is_archived: archived,
      is_read: read,
    },
    update: {
      email_id: "",
      folder_id: rules.folder_id,
      classified_by: rules.classified_by,
      classification_reason: rules.classification_reason,
      ai_confidence: rules.ai_confidence,
      ai_summary: rules.ai_summary || null,
      matched_filter_ids: rules.matched_filter_ids,
      matched_folder_ids: rules.matched_folder_ids,
    },
    snoozed_until: snoozedUntil,
    needs_ai: false,
    folder_id: rules.folder_id,
  };
}

export type CatchupResult = {
  scanned: number;
  inserted: number;
  ai_pending: number;
  fetch_failed: number;
  overflowed: boolean;
};

/** Claim a batch of newly-enqueued jobs, bulk-fetch + bulk-classify +
 * bulk-INSERT them so the user's refetch sees the new mail in one go.
 * Returns counts; anything left in message_jobs after the batch will
 * be drained by the cron lane as before. */
export async function bulkCatchupClaim(
  accountId: string,
  userId: string,
  opts: { limit?: number } = {},
): Promise<CatchupResult> {
  const limit = opts.limit ?? CATCHUP_BULK_LIMIT;

  // ─── 1. Atomic claim. Lock prevents the cron worker from double-
  //         processing while we work.
  const { data: claimedRows, error: claimErr } = await supabaseAdmin.rpc("claim_message_jobs", {
    p_limit: limit,
    p_priority: 0,
  });
  if (claimErr) {
    logError("catchup.claim_failed", { account_id: accountId, user_id: userId }, claimErr);
    return { scanned: 0, inserted: 0, ai_pending: 0, fetch_failed: 0, overflowed: false };
  }
  let jobs = (claimedRows ?? []) as ClaimedJob[];
  // Scope strictly to this account — claim_message_jobs returns across
  // all accounts but the caller is opening one mailbox.
  jobs = jobs.filter((j) => j.gmail_account_id === accountId && j.user_id === userId);
  if (jobs.length === 0) {
    return { scanned: 0, inserted: 0, ai_pending: 0, fetch_failed: 0, overflowed: false };
  }

  // ─── 2. Account context once for the whole batch.
  let ctx: AccountContext;
  try {
    ctx = await loadAccountContext(accountId, userId);
  } catch (e) {
    logError("catchup.context_failed", { account_id: accountId, user_id: userId }, e);
    await releaseClaimed(jobs);
    return { scanned: jobs.length, inserted: 0, ai_pending: 0, fetch_failed: 0, overflowed: false };
  }

  // ─── 3. Bulk Gmail fetch in parallel.
  const fetched = await parallelFetch(accountId, jobs, CATCHUP_FETCH_CONCURRENCY);

  // ─── 4. Classify by rules, build write payloads, partition by needs_ai.
  const toWrite: CatchupBuilt[] = [];
  const rulesMatchedJobIds: string[] = []; // job rows to DELETE (done)
  const pendingAiJobIds: string[] = []; // job rows to RESET → pending
  const releaseJobIds: string[] = []; // jobs whose Gmail fetch failed (transient)
  const folderSideEffects: Array<{
    job: ClaimedJob;
    parsed: Parsed;
    folder: ActionFolder;
    inInbox: boolean;
  }> = [];
  let fetch_failed = 0;

  for (const { job, parsed, error } of fetched) {
    if (!parsed) {
      fetch_failed++;
      // Gmail 404 (deleted in another client) — drop the job silently;
      // anything else — release for the queue's normal retry path.
      if (error && / 404 /.test(error)) {
        rulesMatchedJobIds.push(job.id);
      } else {
        releaseJobIds.push(job.id);
      }
      continue;
    }
    const built = buildCatchupRow(job, parsed, ctx);
    if (!built) {
      // Excluded label (SENT/DRAFT/...) — drop the job silently.
      rulesMatchedJobIds.push(job.id);
      continue;
    }
    toWrite.push(built);
    if (built.needs_ai) {
      pendingAiJobIds.push(job.id);
    } else {
      rulesMatchedJobIds.push(job.id);
      if (built.folder_id) {
        const folder = resolveActionFolder(ctx, built.folder_id);
        if (folder) {
          folderSideEffects.push({
            job,
            parsed,
            folder,
            inInbox: (parsed.raw_labels ?? []).includes("INBOX"),
          });
        }
      }
    }
  }

  // ─── 5. Persist via the encrypted-write RPCs. Sensitive columns are
  //         encrypted at rest (Phase 3) so we cannot bulk-INSERT plaintext;
  //         the RPC upserts on (gmail_account_id, gmail_message_id), which
  //         also handles the rare case where a webhook beat us to it.
  let inserted = 0;
  for (const item of toWrite) {
    const { id, error: upErr } = await upsertEmailEncrypted(item.upsert);
    if (upErr || !id) {
      logError(
        "catchup.upsert_failed",
        { account_id: accountId, gmail_message_id: item.upsert.gmail_message_id },
        upErr,
      );
      continue;
    }
    inserted++;
    if (item.update) {
      const { error: updErr } = await updateEmailEncrypted({ ...item.update, email_id: id });
      if (updErr) {
        logError("catchup.update_failed", { account_id: accountId, email_id: id }, updErr);
      }
    }
    if (item.snoozed_until) {
      await supabaseAdmin.from("emails").update({ snoozed_until: item.snoozed_until }).eq("id", id);
    }
  }

  // ─── 6. Update job queue: drop done jobs, reset AI-needed back to
  //         pending so the live cron lane (5s) picks them up to run AI.
  if (rulesMatchedJobIds.length > 0) {
    await supabaseAdmin.from("message_jobs").delete().in("id", rulesMatchedJobIds);
  }
  if (pendingAiJobIds.length > 0) {
    await supabaseAdmin
      .from("message_jobs")
      .update({
        status: "pending",
        locked_at: null,
        next_run_at: new Date().toISOString(),
      })
      .in("id", pendingAiJobIds);
  }
  if (releaseJobIds.length > 0) {
    await supabaseAdmin
      .from("message_jobs")
      .update({
        status: "pending",
        locked_at: null,
        next_run_at: new Date(Date.now() + 30_000).toISOString(),
      })
      .in("id", releaseJobIds);
  }

  // ─── 7. Folder side effects (Gmail label modify, forward) for
  //         rules-matched mail. persistFlags=false because they're
  //         already in the INSERT.
  if (folderSideEffects.length > 0) {
    await Promise.all(
      folderSideEffects.map(async ({ job, parsed, folder, inInbox }) => {
        try {
          const { data: row } = await supabaseAdmin
            .from("emails")
            .select("id")
            .eq("gmail_account_id", job.gmail_account_id)
            .eq("gmail_message_id", job.gmail_message_id)
            .maybeSingle();
          if (!row) return;
          void bumpEmailsSinceLearn(folder.id);
          await applyFolderActions(
            job.gmail_account_id,
            job.gmail_message_id,
            row.id,
            folder,
            parsed,
            inInbox,
            { persistFlags: false },
          );
        } catch (e) {
          logError(
            "catchup.folder_actions_failed",
            { account_id: job.gmail_account_id, gmail_message_id: job.gmail_message_id },
            e,
          );
        }
      }),
    );
  }

  // ─── 8. Detect overflow — more pending live jobs left in the queue?
  const { count: remainingPending } = await supabaseAdmin
    .from("message_jobs")
    .select("id", { count: "exact", head: true })
    .eq("gmail_account_id", accountId)
    .eq("status", "pending")
    .eq("priority", 0);

  return {
    scanned: jobs.length,
    inserted,
    ai_pending: pendingAiJobIds.length,
    fetch_failed,
    overflowed: (remainingPending ?? 0) > 0,
  };
}

async function releaseClaimed(jobs: ClaimedJob[]) {
  if (jobs.length === 0) return;
  await supabaseAdmin
    .from("message_jobs")
    .update({ status: "pending", locked_at: null })
    .in(
      "id",
      jobs.map((j) => j.id),
    );
}
