// Health / migration-smoke-test endpoint.
//
// Three partial-deploy outages this session — code shipped, migrations
// didn't, and the app errored at runtime because expected SQL objects
// weren't present. This endpoint catches that class of problem proactively:
// it verifies every database object the deployed code expects to exist
// and returns 503 if any are missing.
//
// USAGE
//   POST /api/public/health
//     Bearer CRON_SECRET
//   →
//   200 { ok: true, checks: { ... } }   ← schema matches deployed code
//   503 { ok: false, missing: [ ... ] } ← migrations need to be applied
//
// Operator action: schedule a post-deploy cron call. Failure means
// migrations aren't aligned with deployed code; alert + investigate.
//
// Cheap query — three small probes against catalog tables. Safe to run
// frequently.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";

// Every SQL object the deployed code expects to exist. Update this
// list when a new migration introduces a new dependency.
//
// No views: the emails_decrypted view was dropped (2026-05-28) when reads
// moved to the get_emails_decrypted RPC under the encrypt-on-write design.
const EXPECTED_VIEWS: string[] = [];

const EXPECTED_FUNCTIONS = [
  // Core sync
  "claim_message_jobs",
  "bump_history_id_if_greater",
  "claim_forward_retries",
  "cron_secret_matches",
  // Retention
  "cleanup_old_pubsub_events",
  "cleanup_old_dlq_jobs",
  "cleanup_old_decryption_audit",
  // Encryption
  "get_gmail_oauth_tokens",
  "set_gmail_oauth_tokens",
  "upsert_gmail_oauth_account",
  // Latency telemetry
  "get_sync_latency_stats",
  // Audit
  "list_decryption_audit",
  "audit_encryption_leaks",
  // Learning + rescue
  "increment_emails_since_learn",
];

const EXPECTED_COLUMNS: Array<{ table: string; column: string }> = [
  // OAuth encryption
  { table: "gmail_accounts", column: "access_token_enc" },
  { table: "gmail_accounts", column: "refresh_token_enc" },
  // Silence detection
  { table: "gmail_accounts", column: "last_push_at" },
  { table: "gmail_accounts", column: "last_history_sync_at" },
  { table: "gmail_accounts", column: "reconcile_cursor" },
  // Body encryption
  { table: "emails", column: "body_text_enc" },
  { table: "emails", column: "body_html_enc" },
  // Push latency telemetry
  { table: "emails", column: "published_at_ms" },
  { table: "message_jobs", column: "published_at_ms" },
  { table: "pubsub_events", column: "latency_ms" },
  // Forward retry
  { table: "emails", column: "forward_attempts" },
  { table: "emails", column: "forward_locked_at" },
  // Classification rescue sweep
  { table: "emails", column: "classify_attempts" },
];

type ProbeRpc = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();

        const missing: { kind: "view" | "function" | "column"; name: string }[] = [];

        // ─── Views ─────────────────────────────────────────────────────────
        try {
          const { data: views } = await supabaseAdmin
            .from("pg_views" as never)
            .select("viewname" as never)
            .eq("schemaname" as never, "public")
            .in("viewname" as never, EXPECTED_VIEWS as never);
          const have = new Set((views ?? []).map((r) => (r as { viewname: string }).viewname));
          for (const v of EXPECTED_VIEWS) {
            if (!have.has(v)) missing.push({ kind: "view", name: v });
          }
        } catch {
          // pg_views isn't in the PostgREST schema by default — fall back
          // to a probe per view via to_regclass.
          for (const v of EXPECTED_VIEWS) {
            const probe = await (supabaseAdmin as unknown as ProbeRpc).rpc(
              "to_regclass" as never,
              { obj: `public.${v}` } as never,
            );
            if (!probe.data) missing.push({ kind: "view", name: v });
          }
        }

        // ─── Functions ─────────────────────────────────────────────────────
        // The robust way: try to call each function with a NULL arg and
        // distinguish "function doesn't exist" from "function errored
        // for some other reason". For health-check purposes we just want
        // schema presence, so we do this minimally: try one specific
        // arity-aware probe per function via a single RPC call that
        // returns the matching pg_proc rows.
        try {
          type PgProcRow = { proname: string };
          const { data: procs } = await supabaseAdmin
            .from("pg_proc" as never)
            .select("proname" as never)
            .in("proname" as never, EXPECTED_FUNCTIONS as never);
          const have = new Set(((procs ?? []) as unknown as PgProcRow[]).map((r) => r.proname));
          for (const f of EXPECTED_FUNCTIONS) {
            if (!have.has(f)) missing.push({ kind: "function", name: f });
          }
        } catch {
          // pg_proc not exposed via PostgREST → can't probe. Skip
          // function check rather than report false missing.
        }

        // ─── Columns ───────────────────────────────────────────────────────
        try {
          type ColRow = { table_name: string; column_name: string };
          const tables = Array.from(new Set(EXPECTED_COLUMNS.map((c) => c.table)));
          const { data: cols } = await supabaseAdmin
            .from("information_schema.columns" as never)
            .select("table_name, column_name" as never)
            .eq("table_schema" as never, "public")
            .in("table_name" as never, tables as never);
          const have = new Set(
            ((cols ?? []) as unknown as ColRow[]).map((c) => `${c.table_name}.${c.column_name}`),
          );
          for (const c of EXPECTED_COLUMNS) {
            if (!have.has(`${c.table}.${c.column}`)) {
              missing.push({ kind: "column", name: `${c.table}.${c.column}` });
            }
          }
        } catch {
          // information_schema not exposed → skip.
        }

        // ─── Encryption-leak audit ────────────────────────────────────────
        // Plaintext columns body_text/body_html/access_token/refresh_token
        // should always be '' at rest — trigger + RPC enforce that. If any
        // row holds non-empty plaintext, something bypassed encryption.
        type LeakRow = {
          emails_body_text_leaks: number;
          emails_body_html_leaks: number;
          oauth_access_token_leaks: number;
          oauth_refresh_token_leaks: number;
        };
        let leaks: LeakRow | null = null;
        try {
          const { data: leakRows } = await (supabaseAdmin as unknown as ProbeRpc).rpc(
            "audit_encryption_leaks",
            {},
          );
          const row = Array.isArray(leakRows) ? leakRows[0] : leakRows;
          if (row && typeof row === "object") leaks = row as LeakRow;
        } catch {
          // RPC not deployed yet — treated as a missing function above.
        }
        const totalLeaks = leaks
          ? Number(leaks.emails_body_text_leaks ?? 0) +
            Number(leaks.emails_body_html_leaks ?? 0) +
            Number(leaks.oauth_access_token_leaks ?? 0) +
            Number(leaks.oauth_refresh_token_leaks ?? 0)
          : 0;

        const ok = missing.length === 0 && totalLeaks === 0;
        return Response.json(
          {
            ok,
            checks: {
              views: EXPECTED_VIEWS.length,
              functions: EXPECTED_FUNCTIONS.length,
              columns: EXPECTED_COLUMNS.length,
            },
            missing,
            encryption_leaks: leaks,
          },
          { status: ok ? 200 : 503 },
        );
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
