// Rule-activity server functions: the read side of the executed_rules
// audit log. The write side lives in src/lib/sync/executed-rules.ts and
// runs inside the ingest pipeline.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { listExecutedRulesDecrypted, type ExecutedRuleRow } from "@/lib/sync/executed-rules";

export type { ExecutedRuleRow };

export type FolderOption = { id: string; name: string };

/** Last N classification executions for the caller (default 500, newest
 * first), plus the folder list for the filter dropdown. The decrypting
 * RPC is service-role-only and scoped to the authenticated user id. */
export const listExecutedRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId?: string | null; folderId?: string | null; limit?: number }) =>
    z
      .object({
        accountId: z.string().uuid().nullish(),
        folderId: z.string().uuid().nullish(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .parse(d ?? {}),
  )
  .handler(
    async ({ data, context }): Promise<{ rows: ExecutedRuleRow[]; folders: FolderOption[] }> => {
      const foldersQuery = data.accountId
        ? context.supabase
            .from("folders")
            .select("id, name")
            .eq("gmail_account_id", data.accountId)
            .order("name")
        : context.supabase.from("folders").select("id, name").order("name");
      const [rows, foldersRes] = await Promise.all([
        listExecutedRulesDecrypted({
          userId: context.userId,
          accountId: data.accountId ?? null,
          folderId: data.folderId ?? null,
          limit: data.limit ?? 500,
        }),
        foldersQuery,
      ]);
      if (foldersRes.error) throw new Error(foldersRes.error.message);
      return { rows, folders: (foldersRes.data ?? []) as FolderOption[] };
    },
  );
