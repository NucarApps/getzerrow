import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type InvaderStats = {
  myBest: number | null;
  globalBest: number | null;
  myRank: number | null;
  top5: Array<{ name: string; score: number }>;
};

async function fetchStats(supabase: ReturnType<typeof requireSupabaseAuth> extends never ? never : any): Promise<InvaderStats> {
  const { data, error } = await supabase.rpc("get_invader_stats");
  if (error) throw new Error(error.message);
  return (data ?? { myBest: null, globalBest: null, myRank: null, top5: [] }) as InvaderStats;
}

export const getInvaderStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    return fetchStats(context.supabase);
  });

export const submitInvaderScore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ score: z.number().int().min(0).max(10_000_000) }).parse(input),
  )
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

    const { error } = await supabase.from("game_scores").insert({
      user_id: userId,
      game: "invader",
      score: data.score,
      display_name: displayName,
    });
    if (error) throw new Error(error.message);

    return fetchStats(supabase);
  });
