import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const keyShape = {
  domain: z.string().trim().toLowerCase().nullable().optional(),
  nameKey: z.string().trim().toLowerCase().nullable().optional(),
};

const getInput = z.object(keyShape).refine((v) => !!(v.domain || v.nameKey), {
  message: "domain or nameKey required",
});

const upsertInput = z
  .object({ ...keyShape, description: z.string().max(4000) })
  .refine((v) => !!(v.domain || v.nameKey), { message: "domain or nameKey required" });

function resolveKey(input: { domain?: string | null; nameKey?: string | null }): {
  key_type: "domain" | "name";
  key_value: string;
} {
  if (input.domain) return { key_type: "domain", key_value: input.domain };
  return { key_type: "name", key_value: input.nameKey! };
}

export const getCompanyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => getInput.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const key = resolveKey(data);
    const { data: row, error } = await supabase
      .from("company_profiles")
      .select("description")
      .eq("user_id", userId)
      .eq("key_type", key.key_type)
      .eq("key_value", key.key_value)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { description: row?.description ?? "" };
  });

export const upsertCompanyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => upsertInput.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const key = resolveKey(data);
    const { error } = await supabase.from("company_profiles").upsert(
      {
        user_id: userId,
        key_type: key.key_type,
        key_value: key.key_value,
        description: data.description,
      },
      { onConflict: "user_id,key_type,key_value" },
    );
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

