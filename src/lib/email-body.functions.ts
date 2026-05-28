// Server fns that return decrypted email fields. The inbox UI calls these
// once the plaintext columns are dropped (Phase 3 Migration B).
//
// - getEmailBody: decrypt full body for a single open email.
// - getEmailListFields: batch decrypt ai_summary + classification_reason for
//   the visible rows of a list view. Keeps payloads tiny.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getEmailsDecrypted, getEmailListFieldsDecrypted } from "./sync/encrypted-reader";

export const getEmailBody = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ email_id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { rows, error } = await getEmailsDecrypted([data.email_id]);
    if (error) return { body: null, error };
    const row = rows[0];
    if (!row) return { body: null, error: "not_found" };
    if (row.user_id !== userId) return { body: null, error: "forbidden" };
    return {
      body: {
        id: row.id,
        body_text: row.body_text,
        body_html: row.body_html,
        ai_summary: row.ai_summary,
        classification_reason: row.classification_reason,
      },
      error: null,
    };
  });

export const getEmailListFields = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z.object({ ids: z.array(z.string().uuid()).max(5000) }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    if (data.ids.length === 0) return { fields: [], error: null };
    // Ownership filter: only return rows that belong to this user. Without
    // this any signed-in caller could pass arbitrary ids.
    const { data: owned, error: ownErr } = await supabaseAdmin
      .from("emails")
      .select("id")
      .eq("user_id", userId)
      .in("id", data.ids);
    if (ownErr) return { fields: [], error: ownErr.message };
    const allowedIds = (owned ?? []).map((r) => r.id);
    if (allowedIds.length === 0) return { fields: [], error: null };
    const { rows, error } = await getEmailListFieldsDecrypted(allowedIds);
    if (error) return { fields: [], error };
    return { fields: rows, error: null };
  });
