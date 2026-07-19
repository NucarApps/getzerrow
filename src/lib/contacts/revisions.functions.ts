// Client-callable server functions for the contact revision history.
// Listing snapshots is user-scoped via RLS; restoring goes through the
// server-only helper which uses supabaseAdmin.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ContactRevisionRow = {
  id: string;
  source: string;
  created_at: string;
  contact_name: string | null;
  contact_email: string | null;
};

export const listContactRevisions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { contactId: string }) =>
    z.object({ contactId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<ContactRevisionRow[]> => {
    const { data: rows, error } = await context.supabase
      .from("contact_revisions")
      .select("id, source, created_at, snapshot")
      .eq("contact_id", data.contactId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return (rows ?? []).map((r) => {
      const snap = r.snapshot as {
        contact?: { name?: string | null; email?: string | null };
      } | null;
      return {
        id: r.id,
        source: r.source,
        created_at: r.created_at,
        contact_name: snap?.contact?.name ?? null,
        contact_email: snap?.contact?.email ?? null,
      };
    });
  });

export const restoreContactRevision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { revisionId: string }) =>
    z.object({ revisionId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { restoreContactFromRevision } = await import("@/lib/contacts/revisions.server");
    const result = await restoreContactFromRevision(context.userId, data.revisionId);
    if (!result.ok) throw new Error(result.error ?? "Restore failed");
    return { ok: true };
  });
