// Server functions for the folder settings chat. Two entry points:
//   - proposeFolderChanges: loads one folder's context + calls the model,
//     returns a structured proposal. Read-only; nothing is written.
//   - applyFolderChanges: verifies ownership of the folder + referenced
//     filters, then applies the subset the user approved.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getEmailsDecrypted } from "./sync/encrypted-reader";
import type { Database } from "@/integrations/supabase/types";

type FolderUpdate = Database["public"]["Tables"]["folders"]["Update"];
import {
  proposeFolderChatChanges,
  type FolderChatAction,
  type FolderChatContext,
  type FolderChatMessage,
  type FolderChatProposal,
  type FolderChatSampleEmail,
} from "./folder-chat.server";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(4000),
});

const settingsPatchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    auto_archive: z.boolean().optional(),
    auto_mark_read: z.boolean().optional(),
    auto_star: z.boolean().optional(),
    hide_from_inbox: z.boolean().optional(),
    skip_ai: z.boolean().optional(),
    overrides_inbox_override: z.boolean().optional(),
    is_cold_email: z.boolean().optional(),
    forward_to: z.string().max(320).nullable().optional(),
    snooze_hours: z.number().int().min(0).max(720).optional(),
    min_ai_confidence: z.number().min(0).max(1).optional(),
    filter_logic: z.enum(["any", "all"]).optional(),
  })
  .strict();

const actionInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_filter"),
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
    ai_rule: z.string().min(1).max(500),
    why: z.string().max(400).optional().default(""),
  }),
  z.object({
    type: z.literal("update_folder_profile"),
    learned_profile: z.string().min(1).max(2000),
    why: z.string().max(400).optional().default(""),
  }),
  z.object({
    type: z.literal("update_folder_settings"),
    settings: settingsPatchSchema,
    why: z.string().max(400).optional().default(""),
  }),
]);

// Recent emails sampled from the folder so the AI can see patterns.
const FOLDER_SAMPLE_SIZE = 20;

export const proposeFolderChanges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { folder_id: string; user_message: string; history: FolderChatMessage[] }) =>
      z
        .object({
          folder_id: z.string().uuid(),
          user_message: z.string().min(1).max(2000),
          history: z.array(chatMessageSchema).max(40),
        })
        .parse(d),
  )
  .handler(async ({ data, context }): Promise<FolderChatProposal> => {
    // 1. Verify the folder belongs to this user and load its columns.
    const { data: folderRow } = await supabaseAdmin
      .from("folders")
      .select(
        "id, user_id, gmail_account_id, name, color, priority, ai_rule, learned_profile, auto_archive, auto_mark_read, auto_star, hide_from_inbox, skip_ai, overrides_inbox_override, is_cold_email, forward_to, snooze_hours, min_ai_confidence, filter_logic",
      )
      .eq("id", data.folder_id)
      .maybeSingle();
    if (!folderRow || folderRow.user_id !== context.userId) {
      throw new Error("Folder not found");
    }

    // 2. Load this folder's filters.
    const { data: filterRows } = await supabaseAdmin
      .from("folder_filters")
      .select("id, field, op, value")
      .eq("folder_id", data.folder_id);

    const folder: FolderChatContext = {
      id: folderRow.id,
      name: folderRow.name,
      color: folderRow.color,
      priority: folderRow.priority,
      ai_rule: folderRow.ai_rule,
      learned_profile: folderRow.learned_profile ?? null,
      auto_archive: folderRow.auto_archive,
      auto_mark_read: folderRow.auto_mark_read,
      auto_star: folderRow.auto_star,
      hide_from_inbox: folderRow.hide_from_inbox,
      skip_ai: folderRow.skip_ai,
      overrides_inbox_override: folderRow.overrides_inbox_override,
      is_cold_email: folderRow.is_cold_email,
      forward_to: folderRow.forward_to,
      snooze_hours: folderRow.snooze_hours,
      min_ai_confidence: folderRow.min_ai_confidence,
      filter_logic: folderRow.filter_logic,
      filters: (filterRows ?? []).map((r) => ({
        id: r.id,
        field: r.field,
        op: r.op,
        value: r.value,
      })),
    };

    // 3. Sample recent mail currently in this folder (decrypt display fields).
    const { data: sampleRows } = await supabaseAdmin
      .from("emails")
      .select("id, from_addr, in_reply_to")
      .eq("user_id", context.userId)
      .eq("folder_id", data.folder_id)
      .order("received_at", { ascending: false })
      .limit(FOLDER_SAMPLE_SIZE);

    let sample: FolderChatSampleEmail[] = [];
    const rows = sampleRows ?? [];
    if (rows.length > 0) {
      const dec = await getEmailsDecrypted(rows.map((r) => r.id));
      const decMap = new Map(dec.rows.map((r) => [r.id, r]));
      sample = rows.map((e) => {
        const d = decMap.get(e.id);
        return {
          from_addr: e.from_addr,
          from_name: d?.from_name ?? null,
          subject: d?.subject ?? null,
          snippet: d?.snippet ?? null,
          is_reply: !!(e.in_reply_to && e.in_reply_to.trim()),
          classification_reason: d?.classification_reason ?? null,
        };
      });
    }

    return proposeFolderChatChanges({
      history: data.history,
      userMessage: data.user_message,
      folder,
      sample,
    });
  });

type ApplyResultItem = {
  action: FolderChatAction;
  ok: boolean;
  error?: string;
};

export const applyFolderChanges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string; actions: FolderChatAction[] }) =>
    z
      .object({
        folder_id: z.string().uuid(),
        actions: z.array(actionInputSchema).min(1).max(20),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<{ results: ApplyResultItem[] }> => {
    const userId = context.userId;
    const results: ApplyResultItem[] = [];

    // Verify the folder belongs to this user once, up front.
    const { data: folderRow } = await supabaseAdmin
      .from("folders")
      .select("id, user_id")
      .eq("id", data.folder_id)
      .maybeSingle();
    if (!folderRow || folderRow.user_id !== userId) {
      throw new Error("Folder not found");
    }

    // Pre-verify ownership of every referenced filter (must belong to THIS folder).
    const filterIds = data.actions
      .filter(
        (a): a is Extract<FolderChatAction, { type: "remove_filter" }> =>
          a.type === "remove_filter",
      )
      .map((a) => a.filter_id);
    const ownedFilterIds = new Set<string>();
    if (filterIds.length > 0) {
      const { data: rows } = await supabaseAdmin
        .from("folder_filters")
        .select("id, folder_id")
        .in("id", filterIds)
        .eq("folder_id", data.folder_id);
      for (const r of rows ?? []) ownedFilterIds.add(r.id);
    }

    for (const action of data.actions) {
      try {
        if (action.type === "add_filter") {
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
            .eq("folder_id", data.folder_id)
            .eq("field", action.field)
            .eq("op", action.op)
            .eq("value", value)
            .maybeSingle();
          if (!existing) {
            const { error } = await supabaseAdmin.from("folder_filters").insert({
              folder_id: data.folder_id,
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
          const { error } = await supabaseAdmin
            .from("folders")
            .update({ ai_rule: action.ai_rule.trim() })
            .eq("id", data.folder_id);
          if (error) throw new Error(error.message);
        } else if (action.type === "update_folder_profile") {
          const { error } = await supabaseAdmin
            .from("folders")
            .update({ learned_profile: action.learned_profile.trim() })
            .eq("id", data.folder_id);
          if (error) throw new Error(error.message);
        } else if (action.type === "update_folder_settings") {
          const patch = buildSettingsPatch(action.settings);
          if (Object.keys(patch).length === 0) throw new Error("No settings to change");
          const { error } = await supabaseAdmin
            .from("folders")
            .update(patch)
            .eq("id", data.folder_id);
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

// Clamp/normalize the AI-proposed settings patch to safe DB values.
function buildSettingsPatch(
  s: Extract<FolderChatAction, { type: "update_folder_settings" }>["settings"],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (s.name !== undefined) patch.name = s.name.trim();
  if (s.color !== undefined) patch.color = s.color;
  if (s.priority !== undefined) patch.priority = Math.max(0, Math.min(1000, Math.round(s.priority)));
  if (s.auto_archive !== undefined) patch.auto_archive = s.auto_archive;
  if (s.auto_mark_read !== undefined) patch.auto_mark_read = s.auto_mark_read;
  if (s.auto_star !== undefined) patch.auto_star = s.auto_star;
  if (s.hide_from_inbox !== undefined) patch.hide_from_inbox = s.hide_from_inbox;
  if (s.skip_ai !== undefined) patch.skip_ai = s.skip_ai;
  if (s.overrides_inbox_override !== undefined)
    patch.overrides_inbox_override = s.overrides_inbox_override;
  if (s.is_cold_email !== undefined) patch.is_cold_email = s.is_cold_email;
  if (s.forward_to !== undefined) {
    const trimmed = s.forward_to?.trim();
    patch.forward_to = trimmed ? trimmed : null;
  }
  if (s.snooze_hours !== undefined)
    patch.snooze_hours = Math.max(0, Math.min(720, Math.round(s.snooze_hours)));
  if (s.min_ai_confidence !== undefined)
    patch.min_ai_confidence = Math.max(0, Math.min(1, s.min_ai_confidence));
  if (s.filter_logic !== undefined) patch.filter_logic = s.filter_logic;
  return patch;
}
