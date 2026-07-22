// Runner for the scheduled_actions queue (rules upgrade, task 5). Claims
// due rows via claim_scheduled_actions (SKIP LOCKED, 5-min lease, attempt
// increments on claim) and executes them:
//
//   * call_webhook — decrypts the action's secret, builds the signed
//     payload, and POSTs it (deliver.ts). Bodies are excluded unless the
//     action opted in via include_body.
//   * archive / mark_read / star / label / move_folder — delayed label
//     actions re-dispatch against the email's FRESH state (labels may
//     have changed since enqueue), keeping the handlers' idempotency.
//   * anything else — terminal error until its task lands.
//
// RETRY — a failed attempt reschedules with exponential backoff; attempt
// SCHEDULED_ACTION_MAX_ATTEMPTS fails terminally (status 'error').
// Config-gone cases (action or email deleted, no webhook URL) fail
// terminally right away instead of burning retries.
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError } from "@/lib/log.server";
import { modifyMessage, sendMessage, createDraft } from "../gmail.server";
import { buildWebhookPayload, deliverWebhook } from "../webhook/deliver";
import {
  dispatchFolderActions,
  OUTBOUND_ACTION_TYPES,
  type FolderActionRow,
} from "./action-dispatch";
import { renderTemplate } from "./action-templates";
import { getEmailsDecrypted } from "./encrypted-reader";
import { AI_CLASSIFY_ATTEMPT_TIMEOUT_MS } from "./config";

const admin = () => supabaseAdmin as unknown as SupabaseClient;

/** Backoff (minutes) applied after failed attempt N (1-based index N-1). */
export const SCHEDULED_ACTION_BACKOFF_MINUTES = [1, 5, 15, 60, 180];
export const SCHEDULED_ACTION_MAX_ATTEMPTS = 6;

const LABEL_ACTION_TYPES = new Set(["archive", "mark_read", "star", "label", "move_folder"]);

type ClaimedJob = {
  id: string;
  user_id: string;
  folder_action_id: string | null;
  email_id: string | null;
  attempt: number;
};

type RunOutcome = { ok: true } | { ok: false; error: string; terminal?: boolean };

export async function runScheduledActions(limit = 20): Promise<{
  claimed: number;
  done: number;
  retried: number;
  failed: number;
}> {
  const { data, error } = await admin().rpc("claim_scheduled_actions", { p_limit: limit });
  if (error) throw new Error(error.message);
  const jobs = ((data ?? []) as ClaimedJob[]).filter(Boolean);

  let done = 0;
  let retried = 0;
  let failed = 0;
  for (const job of jobs) {
    let outcome: RunOutcome;
    try {
      outcome = await runOne(job);
    } catch (e) {
      outcome = { ok: false, error: (e as Error)?.message?.slice(0, 300) ?? "unknown" };
    }
    const finished = await finishJob(job, outcome);
    if (finished === "done") done++;
    else if (finished === "retried") retried++;
    else failed++;
  }
  return { claimed: jobs.length, done, retried, failed };
}

async function finishJob(
  job: ClaimedJob,
  outcome: RunOutcome,
): Promise<"done" | "retried" | "failed"> {
  if (outcome.ok) {
    await admin()
      .from("scheduled_actions")
      .update({ status: "done", last_error: null })
      .eq("id", job.id);
    return "done";
  }
  const terminal = outcome.terminal || job.attempt >= SCHEDULED_ACTION_MAX_ATTEMPTS;
  if (terminal) {
    await admin()
      .from("scheduled_actions")
      .update({ status: "error", last_error: outcome.error })
      .eq("id", job.id);
    logError("scheduled_actions.failed", {
      scheduled_action_id: job.id,
      attempt: job.attempt,
      terminal: outcome.terminal ?? false,
    });
    return "failed";
  }
  const backoffMin =
    SCHEDULED_ACTION_BACKOFF_MINUTES[
      Math.min(job.attempt - 1, SCHEDULED_ACTION_BACKOFF_MINUTES.length - 1)
    ];
  await admin()
    .from("scheduled_actions")
    .update({
      status: "pending",
      last_error: outcome.error,
      run_at: new Date(Date.now() + backoffMin * 60_000).toISOString(),
      claimed_at: null,
    })
    .eq("id", job.id);
  return "retried";
}

async function runOne(job: ClaimedJob): Promise<RunOutcome> {
  if (!job.folder_action_id || !job.email_id) {
    return { ok: false, error: "missing action or email reference", terminal: true };
  }

  const { data: fa } = await admin()
    .from("folder_actions")
    .select("id, folder_id, action_type, label_id, move_to_folder_id, enabled")
    .eq("id", job.folder_action_id)
    .maybeSingle();
  if (!fa) return { ok: false, error: "action configuration deleted", terminal: true };
  if (!fa.enabled) return { ok: true }; // disabled since enqueue — quiet no-op

  const { rows, error: emailErr } = await getEmailsDecrypted([job.email_id]);
  if (emailErr) return { ok: false, error: emailErr };
  const email = rows[0];
  if (!email) return { ok: false, error: "email deleted", terminal: true };

  if (fa.action_type === "call_webhook") {
    const { data: cfgRows, error: cfgErr } = await admin().rpc("get_folder_action_webhook", {
      p_action_id: fa.id,
      p_key: process.env.EMAIL_ENC_KEY,
    });
    if (cfgErr) return { ok: false, error: cfgErr.message };
    const cfg = (
      (cfgRows ?? []) as Array<{
        webhook_url: string | null;
        webhook_secret: string | null;
        include_body: boolean;
      }>
    )[0];
    if (!cfg?.webhook_url) {
      return { ok: false, error: "webhook URL not configured", terminal: true };
    }

    let folder: { id: string; name: string } | null = null;
    if (fa.folder_id) {
      const { data: f } = await admin()
        .from("folders")
        .select("id, name")
        .eq("id", fa.folder_id)
        .maybeSingle();
      folder = (f as { id: string; name: string } | null) ?? null;
    }

    const payload = buildWebhookPayload({
      email: {
        id: email.id,
        thread_id: email.thread_id,
        from_addr: email.from_addr,
        from_name: email.from_name,
        subject: email.subject,
        received_at: email.received_at,
        ai_summary: email.ai_summary,
        body_text: email.body_text,
      },
      folder,
      includeBody: cfg.include_body === true,
      deliveryId: job.id,
      deliveredAt: new Date().toISOString(),
    });
    const res = await deliverWebhook({
      url: cfg.webhook_url,
      secret: cfg.webhook_secret ?? null,
      body: JSON.stringify(payload),
      deliveryId: job.id,
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: res.error };
  }

  if (LABEL_ACTION_TYPES.has(fa.action_type)) {
    const inInbox = (email.raw_labels ?? []).includes("INBOX") && !email.is_archived;
    const action: FolderActionRow = {
      id: fa.id,
      action_type: fa.action_type,
      label_id: fa.label_id ?? null,
      move_to_folder_id: fa.move_to_folder_id ?? null,
      delay_minutes: 0, // the delay already elapsed — run inline now
    };
    const { plan, outcomes } = await dispatchFolderActions({
      actions: [action],
      parsed: { raw_labels: email.raw_labels },
      inInbox,
      persistFlags: true,
      emailRowId: email.id,
      userId: job.user_id,
      resolveMoveTarget: async (folderId) => {
        const { data } = await admin()
          .from("folders")
          .select("gmail_label_id")
          .eq("id", folderId)
          .maybeSingle();
        return (data as { gmail_label_id: string | null } | null) ?? null;
      },
    });
    if (outcomes[0]?.status === "error") {
      return { ok: false, error: outcomes[0].error ?? "action failed" };
    }
    if (plan.addLabels.length || plan.removeLabels.length) {
      await modifyMessage(
        email.gmail_account_id,
        email.gmail_message_id,
        plan.addLabels,
        plan.removeLabels,
      );
    }
    if (Object.keys(plan.patch).length > 0) {
      const { error } = await admin().from("emails").update(plan.patch).eq("id", email.id);
      if (error) return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  if (OUTBOUND_ACTION_TYPES.has(fa.action_type)) {
    return runOutbound(fa.id, fa.action_type, email);
  }

  return {
    ok: false,
    error: `action type not supported by the runner yet: ${fa.action_type}`,
    terminal: true,
  };
}

type OutboundEmail = {
  id: string;
  gmail_account_id: string;
  gmail_message_id: string;
  thread_id: string | null;
  from_addr: string | null;
  from_name: string | null;
  subject: string | null;
  body_text: string | null;
  received_at: string | null;
};

/** Race a promise against a hard timeout (AI fallback must stay bounded). */
async function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Execute reply / draft / send_email (task 8). Templates are decrypted
 * via the service-role RPC and rendered against whitelisted tokens; a
 * reply with no template falls back to the timeboxed AI reply drafter.
 * Nothing rendered or AI-generated is ever persisted — the message goes
 * straight to Gmail and the only stored copy is the encrypted template. */
async function runOutbound(
  actionId: string,
  actionType: string,
  email: OutboundEmail,
): Promise<RunOutcome> {
  const { data: cfgRows, error: cfgErr } = await admin().rpc("get_folder_action_outbound", {
    p_action_id: actionId,
    p_key: process.env.EMAIL_ENC_KEY,
  });
  if (cfgErr) return { ok: false, error: cfgErr.message };
  const cfg = (
    (cfgRows ?? []) as Array<{
      subject_template: string | null;
      body_template: string | null;
      to_addr: string | null;
    }>
  )[0];
  if (!cfg) return { ok: false, error: "outbound action configuration missing", terminal: true };

  const templateEmail = {
    from_name: email.from_name,
    from_addr: email.from_addr,
    subject: email.subject,
    body_text: email.body_text,
    received_at: email.received_at,
  };

  let body = cfg.body_template ? renderTemplate(cfg.body_template, templateEmail) : "";
  if (!body && actionType === "reply") {
    // Template-less reply: draft with AI (timeboxed, via the gateway).
    const { suggestReply } = await import("../ai.server");
    body = await raceTimeout(
      suggestReply({
        from_name: email.from_name ?? email.from_addr ?? "",
        subject: email.subject ?? "",
        body_text: email.body_text ?? "",
      }),
      AI_CLASSIFY_ATTEMPT_TIMEOUT_MS,
      "outbound reply draft",
    );
  }
  if (!body.trim()) {
    return { ok: false, error: "no body template configured", terminal: true };
  }

  const replySubject = email.subject?.startsWith("Re:")
    ? email.subject
    : `Re: ${email.subject ?? ""}`;
  const subject = cfg.subject_template
    ? renderTemplate(cfg.subject_template, templateEmail)
    : replySubject;

  if (actionType === "send_email") {
    const to = (cfg.to_addr ?? "").trim();
    if (!to) return { ok: false, error: "send_email requires to_addr", terminal: true };
    await sendMessage(email.gmail_account_id, to, subject, body);
    return { ok: true };
  }

  const to = (email.from_addr ?? "").trim();
  if (!to) return { ok: false, error: "email has no sender address", terminal: true };

  if (actionType === "draft") {
    await createDraft(
      email.gmail_account_id,
      to,
      replySubject,
      body,
      email.thread_id ?? undefined,
      email.gmail_message_id,
    );
    return { ok: true };
  }

  // reply
  await sendMessage(
    email.gmail_account_id,
    to,
    replySubject,
    body,
    email.thread_id ?? undefined,
    email.gmail_message_id,
  );
  return { ok: true };
}
