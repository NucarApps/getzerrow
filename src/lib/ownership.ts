/**
 * Row-ownership guards for server functions that take an id from the client.
 *
 * The service-role client is pulled in with a dynamic import so this module
 * stays free of a top-level `client.server` import — the same reason the
 * callers previously each inlined their own copy of these checks (there were
 * three of assertOwnsContact and two of assertOwnsCompany).
 *
 * A failed lookup surfaces the Postgres message rather than being flattened
 * into "not found", so an RLS or connectivity failure is not misreported as a
 * missing row.
 */

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export async function assertOwnsContact(userId: string, contactId: string): Promise<void> {
  const db = await admin();
  const { data, error } = await db
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Contact lookup failed: ${error.message}`);
  if (!data) throw new Error("Contact not found");
}

export async function assertOwnsCompany(userId: string, companyId: string): Promise<void> {
  const db = await admin();
  const { data, error } = await db
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Company lookup failed: ${error.message}`);
  if (!data) throw new Error("Company not found");
}
