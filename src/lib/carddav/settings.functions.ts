import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const STYLES = ["leaf", "path_slash", "path_dash"] as const;
export type GroupNameStyle = (typeof STYLES)[number];

/** Read the caller's CardDAV display preferences. Returns defaults if no
 * row exists yet (a row is only written on first update). */
export const getCardDavSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("carddav_settings")
      .select("group_name_style")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const raw = (data as { group_name_style?: string } | null)?.group_name_style;
    const style: GroupNameStyle =
      raw === "leaf" || raw === "path_dash" ? raw : "path_slash";
    return { group_name_style: style };
  });

export const updateCardDavSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { group_name_style: GroupNameStyle }) =>
    z.object({ group_name_style: z.enum(STYLES) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("carddav_settings")
      .upsert(
        { user_id: userId, group_name_style: data.group_name_style },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });
