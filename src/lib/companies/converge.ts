// Best-effort convergence after a company↔contact change: re-sync the
// company-in-label rule memberships, then reconcile auto-company subgroup
// parents for the affected contacts. Both steps are non-fatal — a failure
// here must never fail the mutation that triggered it.
//
// Uses dynamic imports so the companies modules don't take a static import
// cycle on the contacts rule/subgroup modules.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export async function convergeCompanyMemberships(
  client: SupabaseClient<Database>,
  userId: string,
  opts: { companyIds?: string[]; contactIds: string[]; bumpResync?: boolean },
): Promise<void> {
  try {
    const { syncCompanyRuleMemberships } = await import("@/lib/contacts/group-rules.functions");
    await syncCompanyRuleMemberships(client, userId, {
      ...(opts.companyIds ? { companyIds: opts.companyIds } : {}),
      contactIds: opts.contactIds,
      bumpResync: opts.bumpResync ?? true,
    });
  } catch {
    // Non-fatal.
  }
  try {
    const { reconcileAutoParentsForContacts } =
      await import("@/lib/contacts/auto-company-subgroups.functions");
    await reconcileAutoParentsForContacts(client, userId, opts.contactIds);
  } catch {
    // Non-fatal.
  }
}
