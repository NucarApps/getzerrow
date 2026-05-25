import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { LOGO_PROVIDER_COUNT } from "@/lib/logo-providers";

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const domainSchema = z.string().trim().toLowerCase().refine((d) => DOMAIN_RE.test(d), {
  message: "Invalid domain",
});

export type CompanyLogoChoice = { domain: string; provider: number };

export const listCompanyLogoChoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CompanyLogoChoice[]> => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("company_logo_choices")
      .select("domain, provider")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return (data ?? []) as CompanyLogoChoice[];
  });

export const setCompanyLogoChoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        domain: domainSchema,
        provider: z.number().int().min(0).max(LOGO_PROVIDER_COUNT - 1),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("company_logo_choices")
      .upsert(
        { user_id: userId, domain: data.domain, provider: data.provider, updated_at: new Date().toISOString() },
        { onConflict: "user_id,domain" },
      );
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const clearCompanyLogoChoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ domain: domainSchema }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("company_logo_choices")
      .delete()
      .eq("user_id", userId)
      .eq("domain", data.domain);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
