// Decision history reader (Phase C).
//
// One server function the AI-decision drawer calls when it opens: the
// stored trace for a message, narrowed to a v2 RulesTrace, plus the
// provenance the engine's continuity stage depends on (did the user place
// this by hand, did they confirm the placement) and any runtime collision
// recorded for it.
//
// Also holds the two provenance writers a user action triggers:
// confirmDecision (this placement is correct) and resolveCollision
// (I have seen the collision card).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isLegacyTrace, parseRulesTrace } from "./trace";
import type { RulesTrace } from "./types";

export type DecisionHistory = {
  trace: RulesTrace | null;
  /** True when the row holds a v1 trace from the previous engine. */
  legacy: boolean;
  placed_by_user: boolean;
  decision_confirmed_at: string | null;
  collisions: Array<{
    id: string;
    level: number;
    winner_rule_id: string | null;
    folder_ids: string[];
    reason: string | null;
    resolved_at: string | null;
    created_at: string;
  }>;
};

const emailIdInput = (d: { email_id: string }) =>
  z.object({ email_id: z.string().uuid() }).parse(d);

export const getDecisionHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator(emailIdInput)
  .handler(async ({ data, context }): Promise<DecisionHistory> => {
    const { supabase } = context;

    // RLS scopes both reads to the caller, so an id they don't own simply
    // returns nothing rather than leaking another mailbox's trace.
    const { data: email } = await supabase
      .from("emails")
      .select("id, decision_trace, placed_by_user, decision_confirmed_at")
      .eq("id", data.email_id)
      .maybeSingle();

    if (!email) {
      return {
        trace: null,
        legacy: false,
        placed_by_user: false,
        decision_confirmed_at: null,
        collisions: [],
      };
    }

    const { data: collisions } = await supabase
      .from("rule_collision_events")
      .select("id, level, winner_rule_id, folder_ids, reason, resolved_at, created_at")
      .eq("email_id", data.email_id)
      .order("created_at", { ascending: false })
      .limit(5);

    return {
      trace: parseRulesTrace(email.decision_trace),
      legacy: isLegacyTrace(email.decision_trace),
      placed_by_user: email.placed_by_user === true,
      decision_confirmed_at: email.decision_confirmed_at ?? null,
      collisions: (collisions ?? []).map((c) => ({
        id: c.id,
        level: c.level,
        winner_rule_id: c.winner_rule_id,
        folder_ids: c.folder_ids ?? [],
        reason: c.reason,
        resolved_at: c.resolved_at,
        created_at: c.created_at,
      })),
    };
  });

/** "This placement is correct." Confirmed placements are what thread
 * continuity (stage 4) and the golden set (Amendment 5) are allowed to
 * chain off — an unconfirmed AI decision never is. */
export const confirmDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(emailIdInput)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("emails")
      .update({ decision_confirmed_at: new Date().toISOString() })
      .eq("id", data.email_id);
    if (error) throw new Error(error.message);
    return { ok: true } as const;
  });

export const resolveCollision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { collision_id: string }) =>
    z.object({ collision_id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("rule_collision_events")
      .update({ resolved_at: new Date().toISOString() })
      .eq("id", data.collision_id);
    if (error) throw new Error(error.message);
    return { ok: true } as const;
  });
