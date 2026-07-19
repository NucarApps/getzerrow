// Server functions for the inbox AI assistant. Two entry points:
//   - proposeAssistantChanges: loads context + calls the model, returns a
//     structured proposal. Read-only; nothing is written.
//   - applyAssistantChanges: validates ownership of every referenced folder,
//     filter, and email, then applies the subset the user approved.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { performMove } from "./move-email.server";
import { getEmailsDecrypted } from "./sync/encrypted-reader";
import { aggregateDomainClusters, extractDomain, matchFolderByName } from "./ai-assistant-context";
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
    type: z.literal("move_matching"),
    field: z.enum(["from", "domain", "subject"]),
    op: z.enum(["contains", "equals", "starts_with"]),
    value: z.string().min(1).max(400),
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
  z.object({
    type: z.literal("update_folder_profile"),
    folder_id: z.string().uuid(),
    learned_profile: z.string().min(1).max(2000),
    why: z.string().max(400).optional().default(""),
  }),
]);

// How many existing emails a single move_matching action may move.
const MOVE_MATCHING_CAP = 200;
// Recent emails sampled from a referenced folder so the AI can see patterns.
const FOLDER_SAMPLE_SIZE = 20;
// Recent account emails scanned to build sender-domain clusters.
const DOMAIN_SCAN_WINDOW = 150;

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
      .select("id, name, ai_rule, learned_profile")
      .eq("user_id", context.userId)
      .eq("gmail_account_id", data.gmail_account_id);

    const folderIds = (folderRows ?? []).map((f) => f.id);
    const folderNameById = new Map((folderRows ?? []).map((f) => [f.id, f.name]));
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
      learned_profile: f.learned_profile ?? null,
      filters: (filterRows ?? [])
        .filter((r) => r.folder_id === f.id)
        .map((r) => ({ id: r.id, field: r.field, op: r.op, value: r.value })),
    }));

    // Shared helper: hydrate plaintext rows with decrypted display fields and
    // derive the extra signals the model reasons over.
    type RawEmailRow = {
      id: string;
      from_addr: string | null;
      folder_id: string | null;
      in_reply_to: string | null;
      list_id: string | null;
    };
    async function toContextEmails(rows: RawEmailRow[]): Promise<AssistantContextEmail[]> {
      if (rows.length === 0) return [];
      const decRes = await getEmailsDecrypted(rows.map((r) => r.id));
      const decMap = new Map(decRes.rows.map((r) => [r.id, r]));
      return rows.map((e) => {
        const d = decMap.get(e.id);
        return {
          id: e.id,
          from_addr: e.from_addr,
          from_name: d?.from_name ?? null,
          subject: d?.subject ?? null,
          snippet: d?.snippet ?? null,
          folder_id: e.folder_id,
          domain: extractDomain(e.from_addr),
          is_reply: !!(e.in_reply_to && e.in_reply_to.trim()),
          list_id: e.list_id,
          classification_reason: d?.classification_reason ?? null,
        };
      });
    }

    // 2. Load the selected emails (scoped to this user), if any.
    let emails: AssistantContextEmail[] = [];
    if (data.selected_email_ids.length > 0) {
      const { data: emailRows } = await supabaseAdmin
        .from("emails")
        .select("id, from_addr, folder_id, in_reply_to, list_id, user_id")
        .in("id", data.selected_email_ids)
        .eq("user_id", context.userId);
      emails = await toContextEmails((emailRows ?? []) as RawEmailRow[]);
    }

    // 3. If the user names a folder, sample its recent mail so the model can
    //    see the misfiling pattern even without hand-picked emails.
    let folderSample:
      { folderId: string; folderName: string; emails: AssistantContextEmail[] } | undefined;
    const referencedFolderId = matchFolderByName(data.user_message, folderRows ?? []);
    if (referencedFolderId) {
      const { data: sampleRows } = await supabaseAdmin
        .from("emails")
        .select("id, from_addr, folder_id, in_reply_to, list_id")
        .eq("user_id", context.userId)
        .eq("gmail_account_id", data.gmail_account_id)
        .eq("folder_id", referencedFolderId)
        .order("received_at", { ascending: false })
        .limit(FOLDER_SAMPLE_SIZE);
      const sampleEmails = await toContextEmails((sampleRows ?? []) as RawEmailRow[]);
      if (sampleEmails.length > 0) {
        folderSample = {
          folderId: referencedFolderId,
          folderName: folderNameById.get(referencedFolderId) ?? "folder",
          emails: sampleEmails,
        };
      }
    }

    // 4. Cluster recent mail by sender domain to power durable domain-filter
    //    suggestions. Plaintext from_addr + folder_id only — no decryption.
    const { data: recentRows } = await supabaseAdmin
      .from("emails")
      .select("from_addr, folder_id")
      .eq("user_id", context.userId)
      .eq("gmail_account_id", data.gmail_account_id)
      .order("received_at", { ascending: false })
      .limit(DOMAIN_SCAN_WINDOW);
    const domainClusters = aggregateDomainClusters(recentRows ?? [], folderNameById);

    return proposeAi({
      history: data.history,
      userMessage: data.user_message,
      emails,
      folders,
      folderSample,
      domainClusters,
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
          a.type === "move_email" || a.type === "move_matching"
            ? [a.to_folder_id]
            : a.type === "add_filter" ||
                a.type === "update_folder_rule" ||
                a.type === "update_folder_profile"
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
      .filter(
        (a): a is Extract<AssistantAction, { type: "remove_filter" }> => a.type === "remove_filter",
      )
      .map((a) => a.filter_id);
    const ownedFilterIds = new Set<string>();
    if (filterIds.length > 0) {
      const { data: rows } = await supabaseAdmin
        .from("folder_filters")
        .select("id, folder_id, folders!inner(user_id)")
        .in("id", filterIds);
      for (const r of (rows ?? []) as Array<{
        id: string;
        folders: { user_id: string } | { user_id: string }[];
      }>) {
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

    // Resolve the email ids that match a move_matching signal, scoped to this
    // user. from/domain match the plaintext from_addr column directly; subject
    // requires a bounded decrypt scan since subjects are encrypted at rest.
    async function findMatchingEmailIds(action: {
      field: "from" | "domain" | "subject";
      op: "contains" | "equals" | "starts_with";
      value: string;
    }): Promise<string[]> {
      const value = action.value.trim();
      if (!value) return [];

      if (action.field === "from" || action.field === "domain") {
        const v = value.toLowerCase().replace(/^@/, "");
        let pattern: string;
        if (action.field === "domain") {
          // Domain match keys off the address host regardless of op.
          pattern = action.op === "equals" ? `%@${v}` : `%${v}%`;
        } else if (action.op === "equals") {
          pattern = v;
        } else if (action.op === "starts_with") {
          pattern = `${v}%`;
        } else {
          pattern = `%${v}%`;
        }
        const { data: rows } = await supabaseAdmin
          .from("emails")
          .select("id")
          .eq("user_id", userId)
          .ilike("from_addr", pattern)
          .order("received_at", { ascending: false })
          .limit(MOVE_MATCHING_CAP);
        return (rows ?? []).map((r) => r.id);
      }

      // subject: bounded scan over recent rows, decrypt, then match in memory.
      const { data: rows } = await supabaseAdmin
        .from("emails")
        .select("id")
        .eq("user_id", userId)
        .order("received_at", { ascending: false })
        .limit(500);
      const ids = (rows ?? []).map((r) => r.id);
      if (ids.length === 0) return [];
      const dec = await getEmailsDecrypted(ids);
      const needle = value.toLowerCase();
      const matched: string[] = [];
      for (const r of dec.rows) {
        const subject = (r.subject ?? "").toLowerCase();
        const hit =
          action.op === "equals"
            ? subject === needle
            : action.op === "starts_with"
              ? subject.startsWith(needle)
              : subject.includes(needle);
        if (hit) matched.push(r.id);
        if (matched.length >= MOVE_MATCHING_CAP) break;
      }
      return matched;
    }

    for (const action of data.actions) {
      try {
        if (action.type === "move_email") {
          if (!ownedEmailIds.has(action.email_id)) throw new Error("Email not owned");
          if (!ownedFolderIds.has(action.to_folder_id)) throw new Error("Folder not owned");
          const r = await performMove(userId, action.email_id, action.to_folder_id);
          if (!r.ok) throw new Error(r.error || "Move failed");
        } else if (action.type === "move_matching") {
          if (!ownedFolderIds.has(action.to_folder_id)) throw new Error("Folder not owned");
          const matchedIds = await findMatchingEmailIds(action);
          let moved = 0;
          for (const id of matchedIds) {
            const r = await performMove(userId, id, action.to_folder_id);
            if (r.ok) moved += 1;
          }
          if (moved === 0 && matchedIds.length === 0) {
            // Not an error — there may simply be no existing mail to move; the
            // paired add_filter still handles future mail.
          }
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
        } else if (action.type === "update_folder_profile") {
          if (!ownedFolderIds.has(action.folder_id)) throw new Error("Folder not owned");
          const { error } = await supabaseAdmin
            .from("folders")
            .update({ learned_profile: action.learned_profile.trim() })
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
