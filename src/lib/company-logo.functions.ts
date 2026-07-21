import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { LOGO_PROVIDER_COUNT } from "@/lib/logo-providers";

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((d) => DOMAIN_RE.test(d), {
    message: "Invalid domain",
  });

export type CompanyLogoChoice = {
  domain: string;
  provider: number;
  source_domain: string | null;
};

export const listCompanyLogoChoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CompanyLogoChoice[]> => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("company_logo_choices")
      .select("domain, provider, source_domain")
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
        provider: z
          .number()
          .int()
          .min(0)
          .max(LOGO_PROVIDER_COUNT - 1),
        sourceDomain: domainSchema.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const source =
      data.sourceDomain && data.sourceDomain !== data.domain ? data.sourceDomain : null;
    const { error } = await supabase.from("company_logo_choices").upsert(
      {
        user_id: userId,
        domain: data.domain,
        provider: data.provider,
        source_domain: source,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,domain" },
    );
    if (error) throw new Error(error.message);
    await bumpCarddavResync(userId);
    await markContactsForDomainPhotoDirty(userId, data.domain);
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
    await bumpCarddavResync(userId);
    await markContactsForDomainPhotoDirty(userId, data.domain);
    return { ok: true as const };
  });

/** After a brand-logo choice for a domain changes, mark the photos of every
 * linked contact whose company owns that domain as dirty so the next Google
 * push repushes the new logo bytes. Best-effort; failures are swallowed. */
async function markContactsForDomainPhotoDirty(userId: string, domain: string): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: dom } = await supabaseAdmin
      .from("company_domains")
      .select("company_id")
      .eq("user_id", userId)
      .eq("domain", domain)
      .maybeSingle();
    const companyId = (dom as { company_id?: string } | null)?.company_id;
    if (!companyId) return;
    const { data: contacts } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("user_id", userId)
      .eq("company_id", companyId);
    const ids = (contacts ?? []).map((c) => (c as { id: string }).id);
    if (!ids.length) return;
    const { markGooglePhotoDirtyMany } = await import("@/lib/google-contacts/mark-dirty.server");
    await markGooglePhotoDirtyMany(userId, ids);
  } catch {
    // Non-fatal.
  }
}

/** Bump the user's CardDAV resync nonce so iPhone picks up the new logo on
 * its next poll. Delegates to the shared bumpResyncNonce (this file used to
 * carry its own copy). Failure is non-fatal — the logo pick still succeeds;
 * iOS just won't refresh until the next real edit or a manual "Force iPhone
 * resync". */
async function bumpCarddavResync(userId: string): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { bumpResyncNonce } = await import("@/lib/carddav/settings.functions");
    await bumpResyncNonce(supabaseAdmin, userId);
  } catch {
    // Swallow — resync bump is best-effort.
  }
}
