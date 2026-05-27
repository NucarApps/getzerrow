// Server functions for the inbox AI assistant. Two entry points:
//   - proposeAssistantChanges: loads context + calls the model, returns a
//     structured proposal. Read-only; nothing is written.
//   - applyAssistantChanges: validates ownership of every referenced folder,
//     filter, and email, then applies the subset the user approved.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  proposeAssistantChanges as proposeAi,
  type AssistantAction,
  type AssistantChatMessage,
  type AssistantContextEmail,
  type AssistantContextFolder,
  type AssistantProposal,
} from "./ai-assistant.server";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(4000),
});

const actionInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("move_email"),
    email_id: z.string().uuid(),
    to_folder_id: z.string().uuid(),
    why: z.string().max(400).optional().default(""),
  }),
  z.object({
    type: z.literal("add_filter"),
    folder_id: z.string().uuid(),
    field: z.enum(["from", "domain", "subject"]),
    op: z.enum(["contains", "equals", "starts_with"]),
    value: z.string().min(1).max(400),
    why: z.string().max(400).optional().default(""),
  }),
  z.object({
    type: z.literal("remove_filter"),
    filter_id: z.string().uuid(),
    why: z.string().max(400).optional().default(""),
  }),
  z.object({
    type: z.literal("update_folder_rule"),
    folder_id: z.string().uuid(),
    ai_rule: z.string().min(1).max(500),
    why: z.string().max(400).optional().default(""),
  }),
]);

export const proposeAssistantChanges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      gmail_account_id: string;
      user_message: string;
      history: AssistantChatMessage[];
      selected_email_ids: string[];
    }) =>
      z
        .object({
          gmail_account_id: z.string().uuid(),
          user_message: z.string().min(1).max(2000),
          history: z.array(chatMessageSchema).max(40),
          selected_email_ids: z.array(z.string().uuid()).max(25),
        })
        .parse(d),
  )
  .handler(async ({ data, context }): Promise<AssistantProposal> => {
    // 1. Verify the gmail account belongs to this user, then load folders +
    //    filters scoped to that account.
    const { data: account } = await supabaseAdmin
      .from("gmail_accounts")
      .select("id, user_id")
      .eq("id", data.gmail_account_id)
      .maybeSingle();
    if (!account || account.user_id !== context.userId) {
      throw new Error("Gmail account not found");
    }

    const { data: folderRows } = await supabaseAdmin
      .from("folders")
      .select("id, name, ai_rule")
      .eq("user_id", context.userId)
      .eq("gmail_account_id", data.gmail_account_id);

    const folderIds = (folderRows ?? []).map((f) => f.id);
    const { data: filterRows } = folderIds.length
      ? await supabaseAdmin
          .from("folder_filters")
          .select("id, folder_id, field, op, value")
          .in("folder_id", folderIds)
      : { data: [] };

    const folders: AssistantContextFolder[] = (folderRows ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      ai_rule: f.ai_rule,
      filters: (filterRows ?? [])
        .filter((r) => r.folder_id === f.id)
        .map((r) => ({ id: r.id, field: r.field, op: r.op, value: r.value })),
    }));

    // 2. Load only the selected emails (scoped to this user).
    let emails: AssistantContextEmail[] = [];
    if (data.selected_email_ids.length > 0) {
      const { data: emailRows } = await supabaseAdmin
        .from("emails")
        .select("id, from_addr, from_name, subject, snippet, folder_id, user_id")
        .in("id", data.selected_email_ids)
        .eq("user_id", context.userId);
      emails = (emailRows ?? []).map((e) => ({
        id: e.id,
        from_addr: e.from_addr,
        from_name: e.from_name,
        subject: e.subject,
        snippet: e.snippet,
        folder_id: e.folder_id,
      }));
    }

    return proposeAi({
      history: data.history,
      userMessage: data.user_message,
      emails,
      folders,
    });
  });

type ApplyResultItem = {
  action: AssistantAction;
  ok: boolean;
  error?: string;
};

export const applyAssistantChanges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { actions: AssistantAction[] }) =>
    z
      .object({
        actions: z.array(actionInputSchema).min(1).max(20),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<{ results: ApplyResultItem[] }> => {
    const userId = context.userId;
    const results: ApplyResultItem[] = [];

    // Pre-load + verify ownership of every referenced folder, filter, and
    // email up front so a partial proposal doesn't half-apply.
    const folderIds = Array.from(
      new Set(
        data.actions.flatMap((a) =>
          a.type === "move_email"
            ? [a.to_folder_id]
            : a.type === "add_filter" || a.type === "update_folder_rule"
              ? [a.folder_id]
              : [],
        ),
      ),
    );
    const ownedFolderIds = new Set<string>();
    if (folderIds.length > 0) {
      const { data: rows } = await supabaseAdmin
        .from("folders")
        .select("id, user_id")
        .in("id", folderIds);
      for (const r of rows ?? []) {
        if (r.user_id === userId) ownedFolderIds.add(r.id);
      }
    }

    const filterIds = data.actions
      .filter((a): a is Extract<AssistantAction, { type: "remove_filter" }> => a.type === "remove_filter")
      .map((a) => a.filter_id);
    const ownedFilterIds = new Set<string>();
    if (filterIds.length > 0) {
      const { data: rows } = await supabaseAdmin
        .from("folder_filters")
        .select("id, folder_id, folders!inner(user_id)")
        .in("id", filterIds);
      for (const r of (rows ?? []) as Array<{ id: string; folders: { user_id: string } | { user_id: string }[] }>) {
        const folder = Array.isArray(r.folders) ? r.folders[0] : r.folders;
        if (folder?.user_id === userId) ownedFilterIds.add(r.id);
      }
    }

    const emailIds = data.actions
      .filter((a): a is Extract<AssistantAction, { type: "move_email" }> => a.type === "move_email")
      .map((a) => a.email_id);
    const ownedEmailIds = new Set<string>();
    if (emailIds.length > 0) {
      const { data: rows } = await supabaseAdmin
        .from("emails")
        .select("id, user_id")
        .in("id", emailIds);
      for (const r of rows ?? []) {
        if (r.user_id === userId) ownedEmailIds.add(r.id);
      }
    }

    // Apply each action. We use performMove indirectly via moveEmailToFolder's
    // logic by calling the underlying helper through a dynamic import to avoid
    // circular imports in tests.
    const { performMove } = await import("./gmail.functions-helpers");

    for (const action of data.actions) {
      try {
        if (action.type === "move_email") {
          if (!ownedEmailIds.has(action.email_id)) throw new Error("Email not owned");
          if (!ownedFolderIds.has(action.to_folder_id)) throw new Error("Folder not owned");
          const r = await performMove(userId, action.email_id, action.to_folder_id);
          if (!r.ok) throw new Error(r.error || "Move failed");
        } else if (action.type === "add_filter") {
          if (!ownedFolderIds.has(action.folder_id)) throw new Error("Folder not owned");
          const value =
            action.field === "subject"
              ? action.value.trim()
              : action.field === "domain"
                ? action.value.trim().toLowerCase().replace(/^@/, "")
                : action.value.trim().toLowerCase();
          if (!value) throw new Error("Empty filter value");
          const { data: existing } = await supabaseAdmin
            .from("folder_filters")
            .select("id")
            .eq("folder_id", action.folder_id)
            .eq("field", action.field)
            .eq("op", action.op)
            .eq("value", value)
            .maybeSingle();
          if (!existing) {
            const { error } = await supabaseAdmin.from("folder_filters").insert({
              folder_id: action.folder_id,
              field: action.field,
              op: action.op,
              value,
            });
            if (error) throw new Error(error.message);
          }
        } else if (action.type === "remove_filter") {
          if (!ownedFilterIds.has(action.filter_id)) throw new Error("Filter not owned");
          const { error } = await supabaseAdmin
            .from("folder_filters")
            .delete()
            .eq("id", action.filter_id);
          if (error) throw new Error(error.message);
        } else if (action.type === "update_folder_rule") {
          if (!ownedFolderIds.has(action.folder_id)) throw new Error("Folder not owned");
          const { error } = await supabaseAdmin
            .from("folders")
            .update({ ai_rule: action.ai_rule.trim() })
            .eq("id", action.folder_id);
          if (error) throw new Error(error.message);
        }
        results.push({ action, ok: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ action, ok: false, error: msg });
      }
    }

    return { results };
  });
