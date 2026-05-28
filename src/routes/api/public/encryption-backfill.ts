// Encryption backfill cron — fills *_enc columns and the search index for
// legacy rows written before Phase 1/2 of the at-rest encryption rollout.
// Idempotent: each RPC only touches rows whose encrypted column is still
// NULL, so repeated runs simply drain the backlog batch-by-batch.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";

type BackfillRpcName =
  | "backfill_emails_encryption"
  | "backfill_reply_drafts_encryption"
  | "backfill_contacts_encryption"
  | "backfill_folder_examples_encryption";

type BackfillRpc = {
  rpc: (
    fn: BackfillRpcName,
    args: { p_batch_limit: number; p_key: string },
  ) => Promise<{ data: number | null; error: { message: string } | null }>;
};

function clampInt(s: string | null, min: number, max: number, fallback: number): number {
  if (s == null) return fallback;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function drain(
  client: BackfillRpc,
  fn: BackfillRpcName,
  key: string,
  batchSize: number,
  maxBatches: number,
  runId: string,
): Promise<{ processed: number; batches: number; error: string | null }> {
  let processed = 0;
  let batches = 0;
  for (let i = 0; i < maxBatches; i++) {
    const r = await client.rpc(fn, { p_batch_limit: batchSize, p_key: key });
    if (r.error) {
      logError(`encryption-backfill.${fn}_error`, { run_id: runId, batches }, r.error);
      return { processed, batches, error: r.error.message };
    }
    const n = r.data ?? 0;
    batches += 1;
    processed += n;
    if (n < batchSize) break;
  }
  return { processed, batches, error: null };
}

export const Route = createFileRoute("/api/public/encryption-backfill")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("encryption-backfill", async ({ runId }) => {
          const key = process.env.EMAIL_ENC_KEY;
          if (!key) {
            logError("encryption-backfill.missing_key", { run_id: runId });
            return Response.json({ ok: false, error: "EMAIL_ENC_KEY missing" }, { status: 500 });
          }

          const url = new URL(request.url);
          const emailBatch    = clampInt(url.searchParams.get("email_batch"),     1, 5000, 500);
          const emailBatches  = clampInt(url.searchParams.get("email_batches"),   1, 50,   10);
          const draftBatch    = clampInt(url.searchParams.get("draft_batch"),     1, 5000, 500);
          const contactBatch  = clampInt(url.searchParams.get("contact_batch"),   1, 5000, 500);
          const exampleBatch  = clampInt(url.searchParams.get("example_batch"),   1, 5000, 1000);

          const client = supabaseAdmin as unknown as BackfillRpc;

          const emails       = await drain(client, "backfill_emails_encryption",          key, emailBatch,   emailBatches, runId);
          const drafts       = await drain(client, "backfill_reply_drafts_encryption",    key, draftBatch,   5,            runId);
          const contacts     = await drain(client, "backfill_contacts_encryption",        key, contactBatch, 5,            runId);
          const examples     = await drain(client, "backfill_folder_examples_encryption", key, exampleBatch, 10,           runId);

          try {
            await supabaseAdmin.from("pubsub_events").insert({
              event_type: "encryption_backfill",
              details: `emails=${emails.processed}/${emails.batches}b drafts=${drafts.processed} contacts=${contacts.processed} examples=${examples.processed}`,
              error: emails.error ?? drafts.error ?? contacts.error ?? examples.error,
            });
          } catch (e) {
            logError("encryption-backfill.audit_log_failed", { run_id: runId }, e);
          }

          return Response.json({
            ok: true,
            run_id: runId,
            emails, drafts, contacts, examples,
          });
        });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
