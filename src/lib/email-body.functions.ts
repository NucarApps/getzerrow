// Server fn that returns the decrypted body + AI summary + classification
// reason for a single email. The inbox UI calls this when an email is
// opened, replacing the previous direct SELECT from the emails_decrypted
// view. Once Phase 3b drops the plaintext columns, this remains the only
// path to read those fields client-side.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getEmailsDecrypted } from "./sync/encrypted-reader";

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
