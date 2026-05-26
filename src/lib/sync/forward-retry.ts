// Forward-to retries.
//
// When auto-forward fails (rate-limited, recipient mailbox down,
// transient 5xx) we don't want to silently drop the user's automation.
// processGmailMessage stamps forward_attempts + forward_next_retry_at
// on the email row when its initial sendMessage throws; this cron tick
// picks those rows up and retries with backoff.
//
// Atomicity: an in-process JS lock isn't enough — two cron replicas
// could both pick the same row and double-send. The claim happens via
// claim_forward_retries SQL function (FOR UPDATE SKIP LOCKED), and
// the function also stamps forwarded_at IS NULL so a row that
// originally succeeded never gets re-forwarded.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendMessage } from "../gmail.server";
import { jitter } from "./backoff";
import { logError } from "../log.server";

const FORWARD_MAX_ATTEMPTS = 5;
// 1m → 5m → 30m → 2h → 6h. Wider spread than the message-job backoff
// table because forward failures are usually slower to clear (recipient
// mailbox down, downstream rate limit, etc.).
const FORWARD_BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];

type ForwardClaim = {
  id: string;
  gmail_account_id: string;
  gmail_message_id: string;
  folder_id: string | null;
  subject: string | null;
  from_addr: string | null;
  from_name: string | null;
  body_text: string | null;
  snippet: string | null;
  received_at: string | null;
  forward_attempts: number;
};

type ForwardClaimRpc = {
  rpc: (
    fn: "claim_forward_retries",
    args: { p_limit: number },
  ) => Promise<{ data: ForwardClaim[] | null; error: { message: string } | null }>;
};

export async function retryForwardAttempts(maxRows = 50) {
  const { data: rows, error } = await (supabaseAdmin as unknown as ForwardClaimRpc).rpc(
    "claim_forward_retries",
    { p_limit: maxRows },
  );
  if (error) {
    logError("forward_retry.claim_rpc_failed", { max_rows: maxRows }, error);
    return { processed: 0, ok: 0, failed: 0, gaveUp: 0, error: error.message };
  }

  let ok = 0;
  let failed = 0;
  let gaveUp = 0;
  for (const row of rows ?? []) {
    let forwardTo: string | null = null;
    if (row.folder_id) {
      const { data: folder } = await supabaseAdmin
        .from("folders")
        .select("forward_to")
        .eq("id", row.folder_id)
        .maybeSingle();
      forwardTo = folder?.forward_to ?? null;
    }
    if (!forwardTo) {
      // Folder was deleted or forward_to cleared — abandon the retry.
      await supabaseAdmin.from("emails").update({
        forward_next_retry_at: null,
        forward_locked_at: null,
        forward_last_error: "forward_to no longer set",
      }).eq("id", row.id);
      gaveUp++;
      continue;
    }

    try {
      await sendMessage(
        row.gmail_account_id,
        forwardTo,
        `Fwd: ${row.subject || "(no subject)"}`,
        `---------- Forwarded message ----------\nFrom: ${row.from_name || ""} <${row.from_addr}>\nDate: ${row.received_at}\nSubject: ${row.subject}\n\n${row.body_text || row.snippet || ""}`,
      );
      await supabaseAdmin.from("emails").update({
        forwarded_to: forwardTo,
        forwarded_at: new Date().toISOString(),
        forward_attempts: 0,
        forward_last_error: null,
        forward_next_retry_at: null,
        forward_locked_at: null,
      }).eq("id", row.id);
      ok++;
    } catch (e) {
      const errMsg = (e as Error)?.message?.slice(0, 500) ?? "unknown";
      const nextAttempt = (row.forward_attempts ?? 0) + 1;
      if (nextAttempt >= FORWARD_MAX_ATTEMPTS) {
        await supabaseAdmin.from("emails").update({
          forward_attempts: nextAttempt,
          forward_last_error: errMsg,
          forward_next_retry_at: null, // give up — operator can re-trigger
          forward_locked_at: null,
        }).eq("id", row.id);
        gaveUp++;
      } else {
        const backoff = jitter(FORWARD_BACKOFF_SECONDS[Math.min(nextAttempt - 1, FORWARD_BACKOFF_SECONDS.length - 1)]);
        await supabaseAdmin.from("emails").update({
          forward_attempts: nextAttempt,
          forward_last_error: errMsg,
          forward_next_retry_at: new Date(Date.now() + backoff * 1000).toISOString(),
          forward_locked_at: null,
        }).eq("id", row.id);
        failed++;
      }
    }
  }
  return { processed: rows?.length ?? 0, ok, failed, gaveUp };
}
