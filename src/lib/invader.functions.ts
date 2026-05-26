import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type InvaderStats = {
  myBest: number | null;
  globalBest: number | null;
  myRank: number | null;
  top5: Array<{ name: string; score: number }>;
  myKills: number;
  myBestCombo: number;
  myPlays: number;
  dailySeed: string | null;
  myDailyBest: number | null;
  dailyTop5: Array<{ name: string; score: number }>;
};

const DEFAULT_STATS: InvaderStats = {
  myBest: null,
  globalBest: null,
  myRank: null,
  top5: [],
  myKills: 0,
  myBestCombo: 0,
  myPlays: 0,
  dailySeed: null,
  myDailyBest: null,
  dailyTop5: [],
};

async function fetchStats(supabase: SupabaseClient): Promise<InvaderStats> {
  const { data, error } = await (supabase as unknown as {
    rpc: (fn: string) => Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc("get_invader_stats");
  if (error) throw new Error(error.message);
  return { ...DEFAULT_STATS, ...((data ?? {}) as Partial<InvaderStats>) };
}

export const getInvaderStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    return fetchStats(context.supabase as unknown as SupabaseClient);
  });

const submitSchema = z.object({
  score: z.number().int().min(0).max(10_000_000),
  level: z.number().int().min(0).max(10_000).optional().default(0),
  kills: z.number().int().min(0).max(1_000_000).optional().default(0),
  maxCombo: z.number().int().min(0).max(10_000).optional().default(0),
  durationMs: z.number().int().min(0).max(60 * 60 * 1000).optional().default(0),
  dailySeed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().default(null),
  achievements: z.array(z.string().min(1).max(64)).max(32).optional().default([]),
});

export const submitInvaderScore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => submitSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: card } = await supabase
      .from("my_cards")
      .select("name, handle")
      .eq("user_id", userId)
      .maybeSingle();

    const rawName =
      (card?.name && card.name.trim()) ||
      (card?.handle && card.handle.trim()) ||
      "Player";
    const displayName = rawName.slice(0, 24);

    const insertRow = {
      user_id: userId,
      game: "invader",
      score: data.score,
      display_name: displayName,
      level: data.level,
      kills: data.kills,
      max_combo: data.maxCombo,
      duration_ms: data.durationMs,
      daily_seed: data.dailySeed,
      achievements: data.achievements,
    };
    const { error } = await supabase
      .from("game_scores")
      .insert(insertRow as unknown as Record<string, unknown>);
    if (error) throw new Error(error.message);

    return fetchStats(supabase as unknown as SupabaseClient);
  });
