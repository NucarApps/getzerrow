// Cron tick: run Google Contacts two-way sync for every enabled account.
//
//   POST /api/public/hooks/google-contacts-sync   (Bearer CRON_SECRET)
import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runGoogleContactsSync } from "@/lib/google-contacts/reconcile.server";
import { logError, logInfo, newRunId } from "@/lib/log.server";

export const Route = createFileRoute("/api/public/hooks/google-contacts-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();

        const runId = newRunId();

        // Enabled accounts: join sync_state.enabled=true with gmail_accounts
        // where the OAuth grant is still alive.
        const { data: rows, error } = await supabaseAdmin
          .from("google_sync_state")
          .select(
            "user_id, gmail_account_id, enabled, sync_interval_minutes, last_incremental_at, locked_at",
          )
          .eq("enabled", true);
        if (error) {
          logError("google_contacts_cron.load_failed", { runId }, error);
          return new Response(JSON.stringify({ ok: false, error: error.message }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }

        let ok = 0;
        let failed = 0;
        let skipped = 0;
        const errors: Array<{ accountId: string; error: string }> = [];
        const nowMs = Date.now();

        for (const row of rows ?? []) {
          const intervalMin = (row.sync_interval_minutes as number | null) ?? 15;
          const lastMs = row.last_incremental_at
            ? new Date(row.last_incremental_at as string).getTime()
            : 0;
          // Skip accounts not yet due — respects per-account cadence. Grace of
          // 30s prevents drift from making a due tick miss.
          if (lastMs > 0 && nowMs - lastMs < intervalMin * 60_000 - 30_000) {
            skipped += 1;
            continue;
          }
          try {
            const res = await runGoogleContactsSync(
              row.user_id as string,
              row.gmail_account_id as string,
            );
            if (res.ok) ok += 1;
            else {
              failed += 1;
              errors.push({
                accountId: row.gmail_account_id as string,
                error: res.error ?? "unknown",
              });
            }
          } catch (e) {
            failed += 1;
            const msg = e instanceof Error ? e.message : String(e);
            errors.push({ accountId: row.gmail_account_id as string, error: msg });
            logError(
              "google_contacts_cron.account_failed",
              { runId, accountId: row.gmail_account_id },
              e,
            );
          }
        }

        logInfo("google_contacts_cron.done", {
          runId,
          total: rows?.length ?? 0,
          ok,
          failed,
          skipped,
        });
        return new Response(
          JSON.stringify({
            ok: true,
            runId,
            total: rows?.length ?? 0,
            ranOk: ok,
            failed,
            skipped,
            errors,
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  },
});
