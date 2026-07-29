import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getOwnedFolder } from "../gmail-helpers.server";
import { invalidateAccountContext } from "../sync/account-context";

export type MarkReadRuleRow = {
  id: string;
  folder_id: string;
  match_type: "email" | "domain";
  value: string;
};

/** Normalize a user-entered sender or domain: trim, lowercase, drop a
 * leading "@". Entries containing "@" are treated as full addresses. */
function normalizeEntry(raw: string): { match_type: "email" | "domain"; value: string } {
  const value = raw.trim().toLowerCase().replace(/^@/, "");
  return { match_type: value.includes("@") ? "email" : "domain", value };
}

async function listRules(folderId: string): Promise<MarkReadRuleRow[]> {
  const { data } = await supabaseAdmin
    .from("folder_mark_read_rules")
    .select("id, folder_id, match_type, value")
    .eq("folder_id", folderId)
    .order("value", { ascending: true });
  return (data ?? []) as MarkReadRuleRow[];
}

export const listFolderMarkReadRules = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string }) =>
    z.object({ folder_id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await getOwnedFolder(context.userId, data.folder_id);
    return { rules: await listRules(data.folder_id) };
  });

export const addFolderMarkReadRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string; value: string }) =>
    z.object({ folder_id: z.string().uuid(), value: z.string().min(3).max(320) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const folder = await getOwnedFolder(context.userId, data.folder_id);
    const entry = normalizeEntry(data.value);
    if (!entry.value.includes(".")) throw new Error("Enter an email address or a domain");
    const { error } = await supabaseAdmin.from("folder_mark_read_rules").upsert(
      {
        user_id: context.userId,
        folder_id: data.folder_id,
        match_type: entry.match_type,
        value: entry.value,
      },
      { onConflict: "folder_id,match_type,value" },
    );
    if (error) throw new Error(error.message);
    invalidateAccountContext(folder.gmail_account_id);
    return { rules: await listRules(data.folder_id) };
  });

export const removeFolderMarkReadRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string; id: string }) =>
    z.object({ folder_id: z.string().uuid(), id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const folder = await getOwnedFolder(context.userId, data.folder_id);
    const { error } = await supabaseAdmin
      .from("folder_mark_read_rules")
      .delete()
      .eq("id", data.id)
      .eq("folder_id", data.folder_id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    invalidateAccountContext(folder.gmail_account_id);
    return { rules: await listRules(data.folder_id) };
  });
