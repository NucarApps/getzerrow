import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError, logInfo } from "@/lib/log.server";
import { consolidateLabelDuplicatesImpl } from "@/lib/contacts/label-duplicates.functions";

// One-time/backstop backfill: merge duplicate labels for every user that has
// name_key collisions, using the same deterministic clusterer as the
// "Auto-merge duplicates" button. Run before the phase-2 migration adds the
// scoped unique index. Bounded per tick so a huge tenant can't blow the
// worker budget — re-run until `users_with_collisions` reaches 0.
const MAX_USERS_PER_TICK = 5;

export const Route = createFileRoute("/api/public/hooks/consolidate-label-duplicates")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("consolidate-label-duplicates", async ({ runId }) => {
          try {
            // Users with ≥2 labels sharing (parent scope, name_key). The
            // generated column makes this a pure index read.
            const { data: rows, error } = await supabaseAdmin
              .from("contact_groups")
              .select("user_id, parent_group_id, name_key")
              .not("name_key", "is", null);
            if (error) throw new Error(error.message);
            const counts = new Map<string, Set<string>>();
            const collisionUsers = new Set<string>();
            for (const r of (rows ?? []) as unknown as Array<{
              user_id: string;
              parent_group_id: string | null;
              name_key: string | null;
            }>) {
              const bucket = `${r.parent_group_id ?? "root"}::${r.name_key}`;
              const seen = counts.get(r.user_id) ?? new Set<string>();
              if (seen.has(bucket)) collisionUsers.add(r.user_id);
              seen.add(bucket);
              counts.set(r.user_id, seen);
            }

            const targets = [...collisionUsers].slice(0, MAX_USERS_PER_TICK);
            const results: Array<Record<string, unknown>> = [];
            for (const userId of targets) {
              const r = await consolidateLabelDuplicatesImpl(supabaseAdmin, userId);
              logInfo("label_consolidation.user_done", { user_id: userId, ...r });
              results.push({ user_id: userId, ...r });
            }
            return new Response(
              JSON.stringify({
                users_with_collisions: collisionUsers.size,
                processed: results.length,
                results,
                run_id: runId,
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          } catch (e) {
            logError("label_consolidation.tick_failed", { run_id: runId }, e);
            return new Response(JSON.stringify({ error: (e as Error)?.message ?? "Failed" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }
        });
      },
    },
  },
});
