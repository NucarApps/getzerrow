import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMessage, parseMessage } from "../gmail.server";
import { logError } from "../log.server";

/** Stop fetching before the platform's request wall-clock limit bites. */
const WALL_BUDGET_MS = 18_000;
/** Gmail fetches in flight at once. Matches the sync pipeline's polite level. */
const CONCURRENCY = 5;

export type OriginBackfillResult = {
  scanned: number;
  updated: number;
  /** ISO timestamp to pass back as `before` to continue, or null when done. */
  next_before: string | null;
  done: boolean;
};

/**
 * Refetch recent messages from Gmail and fill in the forwarding columns
 * (`reply_to_addr`, `origin_addr`, `is_forwarded`) for rows ingested before
 * relay detection understood Google's DMARC rewrite.
 *
 * Deliberately narrow: it never reclassifies, never moves mail, and never
 * touches encrypted fields — only the three sender-origin columns.
 */
export const backfillOriginSenders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { before?: string | null; days?: number; limit?: number }) =>
    z
      .object({
        before: z.string().datetime().nullish(),
        days: z.number().int().min(1).max(365).default(90),
        limit: z.number().int().min(10).max(300).default(150),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<OriginBackfillResult> => {
    const startedAt = Date.now();
    const since = new Date(Date.now() - data.days * 86_400_000).toISOString();

    let q = supabaseAdmin
      .from("emails")
      .select("id, gmail_message_id, gmail_account_id, received_at, from_addr")
      .eq("user_id", context.userId)
      .is("origin_addr", null)
      .gte("received_at", since)
      .order("received_at", { ascending: false })
      .limit(data.limit);
    if (data.before) q = q.lt("received_at", data.before);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const list = rows ?? [];
    if (list.length === 0) {
      return { scanned: 0, updated: 0, next_before: null, done: true };
    }

    let updated = 0;
    let scanned = 0;
    let index = 0;
    let budgetHit = false;

    async function worker() {
      while (index < list.length) {
        if (Date.now() - startedAt > WALL_BUDGET_MS) {
          budgetHit = true;
          return;
        }
        const row = list[index++]!;
        scanned++;
        try {
          const parsed = parseMessage(await getMessage(row.gmail_account_id, row.gmail_message_id));
          if (!parsed.origin_addr && !parsed.reply_to_addr && !parsed.is_forwarded) continue;
          const { error: upErr } = await supabaseAdmin
            .from("emails")
            .update({
              reply_to_addr: parsed.reply_to_addr,
              origin_addr: parsed.origin_addr,
              is_forwarded: parsed.is_forwarded,
            })
            .eq("id", row.id)
            .eq("user_id", context.userId);
          if (upErr) throw new Error(upErr.message);
          updated++;
        } catch (e) {
          // A single unreadable message must not abort the batch; the next run
          // reaches it again because the row still has a null origin.
          logError("gmail.origin_backfill.row_failed", { email_id: row.id }, e);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));

    // Resume from the oldest row we actually looked at, so the next batch
    // continues where this one stopped rather than repeating it.
    const lastScanned = list[Math.max(0, Math.min(index, list.length) - 1)];
    const next_before = lastScanned?.received_at ?? null;
    const done = !budgetHit && list.length < data.limit;

    return { scanned, updated, next_before: done ? null : next_before, done };
  });

/** How much forwarded mail we have already identified, for the settings UI. */
export const getOriginBackfillStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const pending = await supabaseAdmin
      .from("emails")
      .select("id", { count: "exact", head: true })
      .eq("user_id", context.userId)
      .is("origin_addr", null)
      .gte("received_at", since);
    const forwarded = await supabaseAdmin
      .from("emails")
      .select("id", { count: "exact", head: true })
      .eq("user_id", context.userId)
      .eq("is_forwarded", true)
      .gte("received_at", since);
    return { pending: pending.count ?? 0, forwarded: forwarded.count ?? 0 };
  });
