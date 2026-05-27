// Per-folder daily AI summaries. Server-only.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { summarizeFolderEmails } from "./ai.server";
import { insertMessage } from "./gmail.server";

/**
 * Compute the next UTC instant whose local time (in IANA `tz`) equals hour:minute,
 * strictly AFTER `from`.
 */
export function computeNextRun(hour: number, minute: number, tz: string, from: Date = new Date()): Date {
  // Walk forward minute by minute? Too slow. Use approximation then refine.
  // Strategy: try today's hour:minute in tz, if <= from then add days until > from.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });

  function tzOffsetMs(utc: Date): number {
    // Difference between the wall-clock in tz and UTC at this instant.
    const parts = fmt.formatToParts(utc);
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)!.value, 10);
    const asUtc = Date.UTC(
      get("year"), get("month") - 1, get("day"),
      get("hour") % 24, get("minute"), get("second")
    );
    return asUtc - utc.getTime();
  }

  // Build candidate: today's local date in tz at hour:minute, then convert to UTC.
  function localToUtc(year: number, month: number, day: number): Date {
    // Tentative UTC instant assuming offset=0
    const tentative = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
    const offset = tzOffsetMs(tentative);
    return new Date(tentative.getTime() - offset);
  }

  // Get today's date in tz.
  const nowParts = fmt.formatToParts(from);
  const get = (t: string) => parseInt(nowParts.find((p) => p.type === t)!.value, 10);
  let y = get("year");
  let m = get("month");
  let d = get("day");

  for (let i = 0; i < 8; i++) {
    const candidate = localToUtc(y, m, d);
    if (candidate.getTime() > from.getTime()) return candidate;
    // advance one day in local tz
    const next = new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
    const np = fmt.formatToParts(next);
    y = parseInt(np.find((p) => p.type === "year")!.value, 10);
    m = parseInt(np.find((p) => p.type === "month")!.value, 10);
    d = parseInt(np.find((p) => p.type === "day")!.value, 10);
  }
  // Fallback: 24h from now.
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

function buildRfc822(args: {
  fromAddr: string;
  toAddr: string;
  subject: string;
  text: string;
  html: string;
}): string {
  const boundary = `=_zerrow_${Math.random().toString(36).slice(2)}`;
  const date = new Date().toUTCString();
  const messageId = `<zerrow-summary-${Date.now()}-${Math.random().toString(36).slice(2)}@zerrow.local>`;
  const subjectEncoded = `=?UTF-8?B?${Buffer.from(args.subject).toString("base64")}?=`;
  return [
    `From: ${args.fromAddr}`,
    `To: ${args.toAddr}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    `Subject: ${subjectEncoded}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    args.text,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#111">${args.html}</body></html>`,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/**
 * Run a single folder-summary schedule end-to-end. Records errors on the row,
 * always advances next_run_at. Returns ok flag for callers that want to surface it.
 */
export async function runFolderSummary(scheduleId: string): Promise<{ ok: boolean; error?: string; emails?: number }> {
  const { data: schedule, error: sErr } = await supabaseAdmin
    .from("folder_summary_schedules")
    .select("id, user_id, folder_id, gmail_account_id, name, instructions, hour, minute, timezone, last_run_at")
    .eq("id", scheduleId)
    .single();
  if (sErr || !schedule) {
    return { ok: false, error: sErr?.message ?? "Schedule not found" };
  }

  const advance = () => computeNextRun(schedule.hour, schedule.minute, schedule.timezone).toISOString();

  try {
    const { data: folder } = await supabaseAdmin
      .from("folders").select("id, name, user_id, gmail_account_id").eq("id", schedule.folder_id).single();
    if (!folder || folder.user_id !== schedule.user_id) throw new Error("Folder not found");

    const { data: account } = await supabaseAdmin
      .from("gmail_accounts").select("id, email_address").eq("id", schedule.gmail_account_id).single();
    if (!account) throw new Error("Gmail account not found");

    const windowEnd = new Date();
    const windowStart = schedule.last_run_at
      ? new Date(schedule.last_run_at)
      : new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);

    const { data: emails } = await supabaseAdmin
      .from("emails")
      .select("from_addr, from_name, subject, snippet, received_at")
      .eq("user_id", schedule.user_id)
      .eq("folder_id", schedule.folder_id)
      .gte("received_at", windowStart.toISOString())
      .lt("received_at", windowEnd.toISOString())
      .order("received_at", { ascending: false })
      .limit(200);

    const emailCount = emails?.length ?? 0;

    if (emailCount === 0) {
      await supabaseAdmin.from("folder_summary_schedules").update({
        last_run_at: windowEnd.toISOString(),
        next_run_at: advance(),
        last_error: null,
      }).eq("id", schedule.id);
      return { ok: true, emails: 0 };
    }

    const summary = await summarizeFolderEmails({
      folderName: folder.name,
      instructions: schedule.instructions,
      emails: emails ?? [],
    });

    const raw = buildRfc822({
      fromAddr: account.email_address,
      toAddr: account.email_address,
      subject: `[${schedule.name}] ${summary.subject}`,
      text: summary.body_text,
      html: summary.body_html,
    });

    await insertMessage(schedule.gmail_account_id, raw, ["INBOX", "UNREAD"]);

    await supabaseAdmin.from("folder_summary_schedules").update({
      last_run_at: windowEnd.toISOString(),
      next_run_at: advance(),
      last_error: (summary as any)._fallback
        ? "Sent using plain-text fallback (structured AI output failed once)."
        : null,
    }).eq("id", schedule.id);

    return { ok: true, emails: emailCount };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.error(`runFolderSummary ${scheduleId} failed:`, msg);
    await supabaseAdmin.from("folder_summary_schedules").update({
      next_run_at: advance(),
      last_error: msg.slice(0, 500),
    }).eq("id", scheduleId);
    return { ok: false, error: msg };
  }
}

/**
 * Enqueue a digest run as a background job. Returns the job id so the caller
 * can poll for completion instead of blocking on the model.
 */
export async function enqueueFolderSummaryJob(args: { scheduleId: string; userId: string }): Promise<{ jobId: string }> {
  const { data, error } = await supabaseAdmin
    .from("folder_summary_jobs")
    .insert({ schedule_id: args.scheduleId, user_id: args.userId, status: "pending" })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to enqueue digest job");
  return { jobId: data.id };
}

/**
 * Claim and process up to `limit` pending digest jobs. Called from the
 * background cron worker.
 */
export async function processFolderSummaryJobs(limit: number): Promise<{ processed: number; succeeded: number; failed: number }> {
  const { data: claimed, error } = await supabaseAdmin.rpc("claim_folder_summary_jobs", { p_limit: limit });
  if (error) throw new Error(error.message);
  const jobs = (claimed ?? []) as Array<{ id: string; schedule_id: string; user_id: string }>;

  let succeeded = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      const r = await runFolderSummary(job.schedule_id);
      await supabaseAdmin.from("folder_summary_jobs").update({
        status: r.ok ? "done" : "failed",
        error: r.ok ? null : (r.error ?? "Unknown error").slice(0, 500),
        emails_count: r.emails ?? null,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", job.id);
      if (r.ok) succeeded++; else failed++;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      console.error(`processFolderSummaryJobs ${job.id} crashed:`, msg);
      await supabaseAdmin.from("folder_summary_jobs").update({
        status: "failed",
        error: msg.slice(0, 500),
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", job.id);
      failed++;
    }
  }

  return { processed: jobs.length, succeeded, failed };
}

