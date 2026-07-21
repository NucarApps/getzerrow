// Status endpoints for the contacts AI tools: background-scan job state
// (the drawers poll this while a queued scan runs) and per-tool summary
// counts (shown in the AI tools menu so it's obvious the tools are alive).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// contact_enrich_jobs is not in the generated Supabase types yet — go
// through an untyped accessor (same pattern as enrich-jobs.server.ts).
function jobsTable(supabase: unknown) {
  return (supabase as SupabaseClient).from("contact_enrich_jobs");
}

export type AiScanJobStatus = {
  kind: "dedup_scan" | "signature_scan";
  status: "pending" | "running" | "done" | "failed";
  error: string | null;
  created_at: string;
  finished_at: string | null;
} | null;

/** Latest background scan job of the given kind for the caller. The drawer
 * polls this after queueing a scan; `null` means never scanned. */
export const getContactAiScanStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { kind: "dedup_scan" | "signature_scan" }) =>
    z.object({ kind: z.enum(["dedup_scan", "signature_scan"]) }).parse(d),
  )
  .handler(async ({ data, context }): Promise<{ job: AiScanJobStatus }> => {
    const { data: rows, error } = await jobsTable(context.supabase)
      .select("kind, status, error, created_at, finished_at")
      .eq("user_id", context.userId)
      .eq("kind", data.kind)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return { job: ((rows ?? [])[0] as AiScanJobStatus) ?? null };
  });

export type AiToolStatus = {
  pendingCount: number;
  lastActivityAt: string | null;
  scanActive: boolean;
};

/** One-shot summary for the AI tools menu: pending suggestion counts and
 * last activity per tool, plus whether a background scan is in flight. */
export const getContactAiToolsStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({
      context,
    }): Promise<{ groups: AiToolStatus; duplicates: AiToolStatus; enrichment: AiToolStatus }> => {
      const { supabase, userId } = context;

      async function summarize(
        table:
          | "contact_group_suggestions"
          | "contact_duplicate_suggestions"
          | "contact_enrichment_suggestions",
        timeColumn: "created_at" | "updated_at",
      ): Promise<Omit<AiToolStatus, "scanActive">> {
        const [{ count }, { data: latest }] = await Promise.all([
          supabase
            .from(table)
            .select("id", { count: "exact", head: true })
            .eq("user_id", userId)
            .eq("status", "pending"),
          supabase
            .from(table)
            .select(timeColumn)
            .eq("user_id", userId)
            .order(timeColumn, { ascending: false })
            .limit(1),
        ]);
        const row = (latest ?? [])[0] as Record<string, string> | undefined;
        return { pendingCount: count ?? 0, lastActivityAt: row?.[timeColumn] ?? null };
      }

      const [groups, duplicates, enrichment, { data: liveJobs }] = await Promise.all([
        summarize("contact_group_suggestions", "created_at"),
        summarize("contact_duplicate_suggestions", "updated_at"),
        summarize("contact_enrichment_suggestions", "created_at"),
        jobsTable(supabase)
          .select("kind, status")
          .eq("user_id", userId)
          .in("status", ["pending", "running"])
          .in("kind", ["dedup_scan", "signature_scan"]),
      ]);
      const active = new Set(((liveJobs ?? []) as Array<{ kind: string }>).map((j) => j.kind));
      return {
        groups: { ...groups, scanActive: false },
        duplicates: { ...duplicates, scanActive: active.has("dedup_scan") },
        enrichment: { ...enrichment, scanActive: active.has("signature_scan") },
      };
    },
  );
