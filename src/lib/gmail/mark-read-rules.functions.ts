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
  .validator((d: { folder_id: string }) => z.object({ folder_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await getOwnedFolder(context.userId, data.folder_id);
    return { rules: await listRules(data.folder_id) };
  });

export const addFolderMarkReadRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { folder_id: string; value: string }) =>
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
  .validator((d: { folder_id: string; id: string }) =>
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

/** Read the folder's mark-read scope plus what it would currently do with one
 * specific sender/domain. Used by the filter drawer so its default matches the
 * pipeline instead of guessing. */
export const getFolderMarkReadDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { folder_id: string; value: string }) =>
    z.object({ folder_id: z.string().uuid(), value: z.string().min(1).max(320) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await getOwnedFolder(context.userId, data.folder_id);
    const { resolveAutoMarkRead, matchesMarkReadRules } = await import("../sync/mark-read-scope");
    const { data: folder } = await supabaseAdmin
      .from("folders")
      .select("auto_mark_read, mark_read_mode")
      .eq("id", data.folder_id)
      .single();
    const rules = await listRules(data.folder_id);
    const entry = normalizeEntry(data.value);
    // A bare domain has no "@", so probe it as an address at that domain —
    // domain rules match on the domain part either way.
    const probe = entry.match_type === "email" ? entry.value : `probe@${entry.value}`;
    const scope = {
      auto_mark_read: !!folder?.auto_mark_read,
      mark_read_mode: (folder?.mark_read_mode ?? "all") as "all" | "except" | "only",
    };
    return {
      ...scope,
      listed: matchesMarkReadRules(rules, probe),
      would_mark_read: resolveAutoMarkRead(scope, rules, probe),
    };
  });

/** Apply a "mark read / leave unread" choice for one sender or domain to the
 * folder's mark-read scope. Mirrors what the folder editor writes, so the two
 * surfaces can never disagree. */
export const setSenderMarkRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { folder_id: string; value: string; mark_read: boolean }) =>
    z
      .object({
        folder_id: z.string().uuid(),
        value: z.string().min(3).max(320),
        mark_read: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const folder = await getOwnedFolder(context.userId, data.folder_id);
    const { nextMarkReadScope, matchesMarkReadRules } = await import("../sync/mark-read-scope");
    const entry = normalizeEntry(data.value);
    if (!entry.value.includes(".")) throw new Error("Enter an email address or a domain");

    const { data: row } = await supabaseAdmin
      .from("folders")
      .select("auto_mark_read, mark_read_mode")
      .eq("id", data.folder_id)
      .single();
    const rules = await listRules(data.folder_id);
    const probe = entry.match_type === "email" ? entry.value : `probe@${entry.value}`;
    const current = {
      auto_mark_read: !!row?.auto_mark_read,
      mark_read_mode: (row?.mark_read_mode ?? "all") as "all" | "except" | "only",
      listed: matchesMarkReadRules(rules, probe),
    };
    const next = nextMarkReadScope(current, data.mark_read);

    if (
      next.auto_mark_read !== current.auto_mark_read ||
      next.mark_read_mode !== current.mark_read_mode
    ) {
      const { error } = await supabaseAdmin
        .from("folders")
        .update({ auto_mark_read: next.auto_mark_read, mark_read_mode: next.mark_read_mode })
        .eq("id", data.folder_id)
        .eq("user_id", context.userId);
      if (error) throw new Error(error.message);
    }

    if (next.listed) {
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
    } else {
      // Only drop the exact entry the user acted on; broader domain rules that
      // happen to cover it stay untouched.
      const { error } = await supabaseAdmin
        .from("folder_mark_read_rules")
        .delete()
        .eq("folder_id", data.folder_id)
        .eq("user_id", context.userId)
        .eq("match_type", entry.match_type)
        .eq("value", entry.value);
      if (error) throw new Error(error.message);
    }

    invalidateAccountContext(folder.gmail_account_id);
    return { ...next, changed: true };
  });
