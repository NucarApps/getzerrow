// Table-backed cron run log (rules upgrade, task 13).
//
// Long-standing cron endpoints record one pubsub_events row per
// meaningful tick (event_type + details + error) so operators can audit
// runs from the DB — the console JSON from withCronRun disappears with
// the worker. The rules-upgrade crons (run-scheduled-actions,
// categorize-senders, send-digest) skipped that row; this helper closes
// the gap with the same swallow-on-failure contract the other crons
// use: a run log must never fail the run it is logging.
//
// Metadata ONLY — counts, ids, and error strings; never email content.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError } from "../log.server";

const DETAILS_MAX_CHARS = 2000;

export async function logCronRunEvent(
  eventType: string,
  details: string,
  error?: string | null,
): Promise<void> {
  try {
    const { error: insertErr } = await supabaseAdmin.from("pubsub_events").insert({
      event_type: eventType,
      details: details.slice(0, DETAILS_MAX_CHARS),
      error: error ?? null,
    });
    if (insertErr) {
      logError("cron_run_log.write_failed", { event_type: eventType }, insertErr);
    }
  } catch (e) {
    logError("cron_run_log.write_failed", { event_type: eventType }, e);
  }
}
