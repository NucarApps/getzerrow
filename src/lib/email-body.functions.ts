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
import {
  getEmailsDecrypted,
  getEmailListFieldsDecrypted,
  getEmailsListDecrypted,
  searchEmailsDecrypted,
  searchEmailsParticipantsDecrypted,
} from "./sync/encrypted-reader";
import { EMAIL_LIST_COLUMNS } from "./email-list-columns";
import { mergeSearchRows } from "./search-merge";

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
  .inputValidator((data) => z.object({ ids: z.array(z.string().uuid()).max(5000) }).parse(data))
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

// One-shot decrypted, paginated inbox list. Replaces the previous
// two-phase fetch (client metadata query + getEmailListFields decrypt)
// for the default folder/inbox views. Ownership is enforced inside the
// RPC via p_user_id (taken from the authenticated context, never the client).
export const getInboxList = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        account_id: z.string().uuid(),
        scope: z.enum(["all", "all_mail", "no_rules", "folder"]),
        folder_id: z.string().uuid().nullable().default(null),
        cursor: z.string().nullable().default(null),
        limit: z.number().int().min(1).max(500).default(51),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { rows, error } = await getEmailsListDecrypted({
      accountId: data.account_id,
      userId,
      scope: data.scope,
      folderId: data.scope === "folder" ? data.folder_id : null,
      cursor: data.cursor,
      limit: data.limit,
    });
    if (error) return { rows: [], error };
    return { rows, error: null };
  });

// Ranked full-text inbox search. Runs server-side over the GIN-indexed
// email_search_index (via the search_emails RPC), decrypts only the matched
// rows, and returns them already ranked. The browser no longer downloads or
// scores the whole corpus. account_id is optional — when present, results are
// scoped to that connected Gmail account. userId is taken from the
// authenticated context, never the client.
export const searchInbox = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        query: z.string().trim().min(1).max(200),
        // Parsed operator parts. When `from` or `to` is present, the search
        // runs against the participant index across the whole mailbox.
        from: z.string().trim().min(1).max(200).nullable().default(null),
        to: z.string().trim().min(1).max(200).nullable().default(null),
        rest: z.string().trim().max(200).default(""),
        account_id: z.string().uuid().nullable().default(null),
        limit: z.number().int().min(1).max(200).default(100),
        offset: z.number().int().min(0).max(10000).default(0),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const hasOperator = data.from !== null || data.to !== null;
    const { rows: hits, error } = hasOperator
      ? await searchEmailsParticipantsDecrypted({
          userId,
          from: data.from,
          to: data.to,
          rest: data.rest,
          limit: data.limit,
          offset: data.offset,
          accountId: data.account_id,
        })
      : await searchEmailsDecrypted({
          userId,
          query: data.query,
          limit: data.limit,
          offset: data.offset,
          accountId: data.account_id,
        });
    if (error) return { rows: [], error };
    if (hits.length === 0) return { rows: [], error: null };
    // Attach the list-view metadata here (one in-region query) instead of a
    // second client round-trip. The user filter is mandatory — the admin
    // client bypasses RLS.
    const { data: metaRows, error: metaErr } = await supabaseAdmin
      .from("emails")
      .select(EMAIL_LIST_COLUMNS)
      .in(
        "id",
        hits.map((h) => h.id),
      )
      .eq("user_id", userId);
    if (metaErr) return { rows: [], error: metaErr.message };
    const merged = mergeSearchRows(hits, (metaRows ?? []) as unknown as Array<{ id: string }>);
    return { rows: merged, error: null };
  });
