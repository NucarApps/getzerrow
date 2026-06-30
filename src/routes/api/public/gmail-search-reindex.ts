// Email search sender-backfill cron.
//
// The search index originally covered only subject/snippet/body. To support
// "search by name or email", `reindex_email_search_sender` appends the sender
// (from_addr/from_name) and recipient (to_addrs) tokens to existing index rows,
// newest-first, gated by the `has_sender` flag so it is idempotent. New + re-
// filed mail is already indexed with sender tokens at write time; this drains
// the historical backlog batch-by-batch.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";

type ReindexRpc = {
  rpc: (
    fn: "reindex_email_search_sender",
    args: { p_batch_limit: number; p_key: string },
  ) => Promise<{ data: number | null; error: { message: string } | null }>;
};

function clampInt(s: string | null, min: number, max: number, fallback: number): number {
  if (s == null) return fallback;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export const Route = createFileRoute("/api/public/gmail-search-reindex")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("gmail-search-reindex", async ({ runId }) => {
          const key = process.env.EMAIL_ENC_KEY;
          if (!key) {
            logError("gmail-search-reindex.missing_key", { run_id: runId });
            return Response.json({ ok: false, error: "EMAIL_ENC_KEY missing" }, { status: 500 });
          }

          const url = new URL(request.url);
          const batch = clampInt(url.searchParams.get("batch"), 1, 5000, 1000);
          const maxBatches = clampInt(url.searchParams.get("batches"), 1, 50, 5);

          const client = supabaseAdmin as unknown as ReindexRpc;
          let processed = 0;
          let batches = 0;
          let error: string | null = null;

          for (let i = 0; i < maxBatches; i++) {
            const r = await client.rpc("reindex_email_search_sender", {
              p_batch_limit: batch,
              p_key: key,
            });
            if (r.error) {
              error = r.error.message;
              logError("gmail-search-reindex.rpc_error", { run_id: runId, batches }, r.error);
              break;
            }
            const n = r.data ?? 0;
            batches += 1;
            processed += n;
            if (n < batch) break;
          }

          return Response.json({ ok: error == null, run_id: runId, processed, batches, error });
        });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
