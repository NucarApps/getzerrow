// Background backfill — paginates through older Gmail messages and
// enqueues them onto the priority=10 lane.
//
// THREE ENTRY POINTS
//
//   backfillRecent(accountId, userId, maxResults=100)
//     Quick bootstrap. Pulls up to maxResults messages from the last
//     30 days and enqueues them at priority=0 (live lane) so they
//     drain immediately. Used by:
//       - The OAuth-callback flow (first-time connect)
//       - bootstrapAccount fallback when there's no local email
//         anchor (sync/history.ts)
//
//   backfillWindow(accountId, userId, { query, maxMessages, concurrency })
//     Synchronous, in-process pagination of a Gmail query. Calls
//     processGmailMessage directly with bounded concurrency — bypasses
//     the queue entirely. Used by ad-hoc operator backfills via the
//     UI's "Catch up last 7 days" button.
//
//   startBackfillJob / tickBackfillJobs / cancelBackfillJob
//     Durable background backfill. The "Pull last N months" button
//     creates a backfill_jobs row, then a cron tick paginates Gmail
//     in 2000-id batches per call, persisting page tokens between
//     ticks. Status transitions:
//       listing  → walking Gmail, enqueueing new ids
//       processing → waiting for message_jobs to drain
//       done       → terminal
//       canceled   → terminal (operator canceled)
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { listMessages } from "../gmail.server";
import { enqueueMessageJobs } from "./queue";
import { processGmailMessage } from "./process-message";

export async function backfillRecent(accountId: string, userId: string, maxResults = 100) {
  // Enqueue at priority=0 (live lane) so the dedicated live worker
  // drains within seconds and we don't block the calling request
  // (often the Pub/Sub webhook). 30d window covers longer outages.
  const list = await listMessages(accountId, {
    maxResults,
    q: "-in:chats -in:trash -in:spam newer_than:30d",
  });
  const ids = (list.messages ?? []).map((m) => m.id);
  try {
    await enqueueMessageJobs(accountId, userId, ids, 0);
  } catch (e) {
    console.error("backfillRecent bulk enqueue failed", e);
    return { processed: 0, enqueued: 0, error: (e as Error).message };
  }
  return { processed: ids.length, enqueued: ids.length };
}

export async function backfillWindow(
  accountId: string,
  userId: string,
  opts: { query: string; maxMessages?: number; concurrency?: number },
) {
  const started = Date.now();
  const maxMessages = opts.maxMessages ?? 1000;
  const concurrency = opts.concurrency ?? 4;

  // 1) Page through Gmail collecting IDs, de-duped.
  const ids: string[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  while (ids.length < maxMessages) {
    const remaining = maxMessages - ids.length;
    const list = await listMessages(accountId, {
      q: opts.query,
      maxResults: Math.min(100, remaining),
      pageToken,
    });
    for (const m of list.messages ?? []) {
      if (!seen.has(m.id)) { seen.add(m.id); ids.push(m.id); }
      if (ids.length >= maxMessages) break;
    }
    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }

  // 2) Drop IDs we already have for this account (batched).
  let alreadyHad = 0;
  const todo: string[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    const { data: existing } = await supabaseAdmin
      .from("emails")
      .select("gmail_message_id")
      .eq("gmail_account_id", accountId)
      .in("gmail_message_id", slice);
    const have = new Set((existing ?? []).map((r) => r.gmail_message_id));
    for (const id of slice) {
      if (have.has(id)) alreadyHad++;
      else todo.push(id);
    }
  }

  // 3) Process with bounded concurrency.
  let processed = 0;
  let failed = 0;
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) return;
      try {
        await processGmailMessage(accountId, todo[i], userId);
        processed++;
      } catch (e) {
        failed++;
        console.error("backfillWindow process failed", todo[i], e);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

  return {
    found: ids.length,
    alreadyHad,
    processed,
    failed,
    durationMs: Date.now() - started,
  };
}

// ─── Deep backfill jobs (background, paginated across cron ticks) ────────

type BackfillJob = {
  id: string;
  user_id: string;
  gmail_account_id: string;
  query: string;
  status: string;
  next_page_token: string | null;
  total_found: number;
  total_enqueued: number;
  already_had: number;
};

const BACKFILL_LIST_PAGES_PER_TICK = 20; // ~2000 IDs per tick
const BACKFILL_PAGE_SIZE = 100;

export async function startBackfillJob(
  accountId: string,
  userId: string,
  opts: { months: number },
): Promise<{ job_id: string; reused: boolean }> {
  const months = Math.min(Math.max(opts.months, 1), 120);

  // Reuse any active job for this account.
  const { data: existing } = await supabaseAdmin
    .from("backfill_jobs")
    .select("id")
    .eq("gmail_account_id", accountId)
    .in("status", ["listing", "processing"])
    .limit(1)
    .maybeSingle();
  if (existing) return { job_id: existing.id, reused: true };

  // Use a date anchor so the query is stable across ticks
  // (newer_than:Nd would shift as time passes). Gmail "after:"
  // accepts YYYY/MM/DD.
  const since = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000);
  const y = since.getUTCFullYear();
  const m = String(since.getUTCMonth() + 1).padStart(2, "0");
  const d = String(since.getUTCDate()).padStart(2, "0");
  const query = `after:${y}/${m}/${d} -in:chats -in:trash -in:spam`;

  const { data: row, error } = await supabaseAdmin
    .from("backfill_jobs")
    .insert({
      user_id: userId,
      gmail_account_id: accountId,
      query,
      months,
      status: "listing",
    })
    .select("id")
    .single();
  if (error || !row) throw new Error(`Failed to start backfill: ${error?.message}`);
  return { job_id: row.id, reused: false };
}

export async function cancelBackfillJob(jobId: string, userId: string) {
  await supabaseAdmin
    .from("backfill_jobs")
    .update({ status: "canceled", finished_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("user_id", userId)
    .in("status", ["listing", "processing"]);
  return { ok: true };
}

export async function tickBackfillJobs(maxJobs = 2) {
  const { data: jobs } = await supabaseAdmin
    .from("backfill_jobs")
    .select("id, user_id, gmail_account_id, query, status, next_page_token, total_found, total_enqueued, already_had")
    .in("status", ["listing", "processing"])
    .order("updated_at", { ascending: true })
    .limit(maxJobs);
  const results: Array<{ job_id: string; phase: string; added?: number; error?: string }> = [];
  for (const job of (jobs ?? []) as BackfillJob[]) {
    try {
      const r = await tickBackfillJob(job);
      results.push({ job_id: job.id, ...r });
    } catch (e: unknown) {
      console.error("tickBackfillJob failed", job.id, e);
      await supabaseAdmin
        .from("backfill_jobs")
        .update({ last_error: String((e as Error)?.message ?? e).slice(0, 500) })
        .eq("id", job.id);
      results.push({ job_id: job.id, phase: "error", error: String((e as Error)?.message ?? e) });
    }
  }
  return { processed: results.length, results };
}

async function tickBackfillJob(job: BackfillJob): Promise<{ phase: string; added?: number }> {
  if (job.status === "listing") {
    let pageToken: string | undefined = job.next_page_token ?? undefined;
    let foundDelta = 0;
    let enqueuedDelta = 0;
    let alreadyDelta = 0;
    let pages = 0;

    while (pages < BACKFILL_LIST_PAGES_PER_TICK) {
      const list = await listMessages(job.gmail_account_id, {
        q: job.query,
        maxResults: BACKFILL_PAGE_SIZE,
        pageToken,
      });
      const ids = (list.messages ?? []).map((m) => m.id);
      foundDelta += ids.length;
      pages++;

      if (ids.length > 0) {
        // Dedupe vs already-stored emails for this account.
        const { data: existing } = await supabaseAdmin
          .from("emails")
          .select("gmail_message_id")
          .eq("gmail_account_id", job.gmail_account_id)
          .in("gmail_message_id", ids);
        const have = new Set((existing ?? []).map((r) => r.gmail_message_id));
        const todo = ids.filter((id) => !have.has(id));
        alreadyDelta += ids.length - todo.length;

        // Single batched upsert per page (vs N×roundtrip).
        try {
          await enqueueMessageJobs(job.gmail_account_id, job.user_id, todo, 10);
          enqueuedDelta += todo.length;
        } catch (e) {
          console.error("backfill page bulk enqueue failed", e);
        }
      }

      pageToken = list.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    const done = !pageToken;
    await supabaseAdmin
      .from("backfill_jobs")
      .update({
        next_page_token: pageToken ?? null,
        total_found: job.total_found + foundDelta,
        total_enqueued: job.total_enqueued + enqueuedDelta,
        already_had: job.already_had + alreadyDelta,
        status: done ? "processing" : "listing",
      })
      .eq("id", job.id);

    return { phase: done ? "listed" : "listing", added: enqueuedDelta };
  }

  // processing: drain wait — check remaining message_jobs for this account.
  const { count } = await supabaseAdmin
    .from("message_jobs")
    .select("id", { count: "exact", head: true })
    .eq("gmail_account_id", job.gmail_account_id)
    .neq("status", "dlq");

  if ((count ?? 0) === 0) {
    await supabaseAdmin
      .from("backfill_jobs")
      .update({ status: "done", finished_at: new Date().toISOString() })
      .eq("id", job.id);
    return { phase: "done" };
  }

  // Touch updated_at so the picker rotates fairly.
  await supabaseAdmin
    .from("backfill_jobs")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", job.id);
  return { phase: "draining" };
}
