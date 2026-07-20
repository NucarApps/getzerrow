// Live progress reporting for a Google Contacts sync run. Writes to
// google_sync_state so the settings UI can poll the current step + counts
// while a sync is in flight. Failures are swallowed — progress is best-effort
// telemetry, never a reason to abort the actual sync.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type ProgressStep =
  | "starting"
  | "pulling_groups"
  | "pulling_contacts"
  | "pushing_groups"
  | "pushing_contacts"
  | "pushing_memberships"
  | "applying_tombstones"
  | "finalizing"
  | "done";

export type ProgressReporter = {
  set: (step: ProgressStep, processed?: number, total?: number) => Promise<void>;
  increment: (delta?: number) => Promise<void>;
  clear: () => Promise<void>;
};

export function createProgressReporter(stateId: string): ProgressReporter {
  let currentStep: ProgressStep = "starting";
  let processed = 0;
  let total = 0;

  async function write(): Promise<void> {
    try {
      await supabaseAdmin
        .from("google_sync_state")
        .update({
          progress_step: currentStep,
          progress_processed: processed,
          progress_total: total,
          progress_updated_at: new Date().toISOString(),
        })
        .eq("id", stateId);
    } catch {
      // best-effort; do not surface
    }
  }

  return {
    async set(step, p, t) {
      currentStep = step;
      if (typeof p === "number") processed = p;
      if (typeof t === "number") total = t;
      await write();
    },
    async increment(delta = 1) {
      processed += delta;
      await write();
    },
    async clear() {
      try {
        await supabaseAdmin
          .from("google_sync_state")
          .update({
            progress_step: null,
            progress_processed: 0,
            progress_total: 0,
            progress_updated_at: new Date().toISOString(),
          })
          .eq("id", stateId);
      } catch {
        // ignore
      }
    },
  };
}
