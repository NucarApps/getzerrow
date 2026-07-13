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
  summarizeFolderChat,
  type FolderChatAction,
  type FolderChatContext,
  type FolderChatMessage,
  type FolderChatProposal,
  type FolderChatSampleEmail,
} from "./folder-chat.server";

// How many of the most recent stored turns are replayed to the model verbatim.
const RECENT_TURNS = 12;
// When more than this many unsummarized turns accumulate, fold the oldest into
// the rolling memory summary.
const SUMMARIZE_THRESHOLD = 24;
// How many turns to keep unsummarized after a summarization pass.
const KEEP_AFTER_SUMMARY = 8;
// Cap on how many stored messages we return for UI rehydration.
const HISTORY_DISPLAY_LIMIT = 200;

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(4000),
});

// A one-line, human-readable description of an applied action, used to feed the
// "changes already applied" memory back to the model.
function describeAppliedAction(action: FolderChatAction): string {
  switch (action.type) {
    case "add_filter":
      return `Added filter: ${action.field} ${action.op} "${action.value}"`;
    case "remove_filter":
      return "Removed a filter";
    case "update_folder_rule":
      return `Set AI rule to "${action.ai_rule}"`;
    case "update_folder_profile":
      return "Rewrote the learned profile";
    case "update_folder_settings": {
      const keys = Object.keys(action.settings);
      return `Updated settings: ${keys.join(", ")}`;
    }
    default:
      return "Applied a change";
  }
}

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
    op: z.enum(["contains", "equals", "starts_with", "not_contains", "not_equals", "domain_in"]),
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

export type ProposeResult = FolderChatProposal & { message_id: string | null };

export const proposeFolderChanges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string; user_message: string; history?: FolderChatMessage[] }) =>
    z
      .object({
        folder_id: z.string().uuid(),
        user_message: z.string().min(1).max(2000),
        // Retained for backward compatibility but ignored: history now comes
        // from the persisted per-folder chat log.
        history: z.array(chatMessageSchema).max(40).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<ProposeResult> => {
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

    // 4. Load persisted memory: rolling summary + recent stored turns + the log
    //    of changes already applied. This is what makes the chat "remember".
    const { data: stateRow } = await supabaseAdmin
      .from("folder_chat_state")
      .select("summary")
      .eq("folder_id", data.folder_id)
      .maybeSingle();
    const memorySummary = stateRow?.summary ?? "";

    const { data: recentRows } = await supabaseAdmin
      .from("folder_chat_messages")
      .select("role, content, actions, applied_action_indexes, discarded")
      .eq("folder_id", data.folder_id)
      .order("created_at", { ascending: false })
      .limit(RECENT_TURNS);
    const recent = (recentRows ?? []).slice().reverse();

    const history: FolderChatMessage[] = recent
      .filter((m) => (m.content ?? "").trim().length > 0)
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));

    const appliedLog: string[] = [];
    const rejectedLog: string[] = [];
    for (const m of recent) {
      if (m.role !== "assistant" || !Array.isArray(m.actions)) continue;
      const rawActions = m.actions as unknown[];
      const indexes = Array.isArray(m.applied_action_indexes)
        ? (m.applied_action_indexes as number[])
        : [];
      for (const idx of indexes) {
        const parsed = actionInputSchema.safeParse(rawActions[idx]);
        if (parsed.success) appliedLog.push(describeAppliedAction(parsed.data));
      }
      // A discarded assistant turn means the user rejected every action it
      // proposed that was not applied. Record those so the model won't re-suggest them.
      if (m.discarded) {
        const appliedSet = new Set(indexes);
        rawActions.forEach((raw, idx) => {
          if (appliedSet.has(idx)) return;
          const parsed = actionInputSchema.safeParse(raw);
          if (parsed.success) rejectedLog.push(describeAppliedAction(parsed.data));
        });
      }
    }

    // 5. Persist the incoming user message before calling the model.
    await supabaseAdmin.from("folder_chat_messages").insert({
      folder_id: data.folder_id,
      user_id: context.userId,
      role: "user",
      content: data.user_message,
    });

    // 6. Ask the model, feeding it the live folder context + persisted memory.
    const proposal = await proposeFolderChatChanges({
      history,
      userMessage: data.user_message,
      folder,
      sample,
      memorySummary,
      appliedLog,
      rejectedLog,
    });

    // 7. Persist the assistant reply (with its proposed actions).
    const assistantContent = proposal.reply || proposal.clarifying_question || "";
    const { data: assistantRow } = await supabaseAdmin
      .from("folder_chat_messages")
      .insert({
        folder_id: data.folder_id,
        user_id: context.userId,
        role: "assistant",
        content: assistantContent,
        actions: proposal.actions.length > 0 ? proposal.actions : null,
      })
      .select("id")
      .maybeSingle();

    // 8. Fold older turns into the rolling summary when history grows long.
    await maybeSummarize(data.folder_id, context.userId, folder.name, memorySummary);

    return { ...proposal, message_id: assistantRow?.id ?? null };
  });

// Best-effort rolling summarization. When too many unsummarized turns pile up,
// condense the oldest into the folder's memory summary and mark them summarized
// so future prompts only replay the recent window verbatim.
async function maybeSummarize(
  folderId: string,
  userId: string,
  folderName: string,
  previousSummary: string,
): Promise<void> {
  try {
    const { count } = await supabaseAdmin
      .from("folder_chat_messages")
      .select("id", { count: "exact", head: true })
      .eq("folder_id", folderId)
      .eq("summarized", false);
    if (!count || count <= SUMMARIZE_THRESHOLD) return;

    const toFold = count - KEEP_AFTER_SUMMARY;
    if (toFold <= 0) return;

    const { data: oldRows } = await supabaseAdmin
      .from("folder_chat_messages")
      .select("id, role, content")
      .eq("folder_id", folderId)
      .eq("summarized", false)
      .order("created_at", { ascending: true })
      .limit(toFold);
    const olds = oldRows ?? [];
    if (olds.length === 0) return;

    const turns: FolderChatMessage[] = olds
      .filter((m) => (m.content ?? "").trim().length > 0)
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));

    const nextSummary = await summarizeFolderChat({
      folderName,
      previousSummary,
      turns,
    });

    await supabaseAdmin
      .from("folder_chat_state")
      .upsert(
        { folder_id: folderId, user_id: userId, summary: nextSummary, summarized_through: new Date().toISOString() },
        { onConflict: "folder_id" },
      );

    await supabaseAdmin
      .from("folder_chat_messages")
      .update({ summarized: true })
      .in(
        "id",
        olds.map((m) => m.id),
      );
  } catch (err: unknown) {
    console.error("maybeSummarize failed", err instanceof Error ? err.message : String(err));
  }
}

// Load the persisted chat history + memory summary so the UI can rehydrate.
export type StoredChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  actions: FolderChatAction[] | null;
  applied_action_indexes: number[];
  created_at: string;
};

export const getFolderChatHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string }) =>
    z.object({ folder_id: z.string().uuid() }).parse(d),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<{ messages: StoredChatMessage[]; summary: string }> => {
      const { data: folderRow } = await supabaseAdmin
        .from("folders")
        .select("id, user_id")
        .eq("id", data.folder_id)
        .maybeSingle();
      if (!folderRow || folderRow.user_id !== context.userId) {
        throw new Error("Folder not found");
      }

      const { data: rows } = await supabaseAdmin
        .from("folder_chat_messages")
        .select("id, role, content, actions, applied_action_indexes, created_at")
        .eq("folder_id", data.folder_id)
        .order("created_at", { ascending: false })
        .limit(HISTORY_DISPLAY_LIMIT);

      const messages: StoredChatMessage[] = (rows ?? [])
        .slice()
        .reverse()
        .map((m) => {
          const rawActions = Array.isArray(m.actions) ? (m.actions as unknown[]) : null;
          const actions = rawActions
            ? rawActions
                .map((a) => actionInputSchema.safeParse(a))
                .filter((p): p is { success: true; data: FolderChatAction } => p.success)
                .map((p) => p.data)
            : null;
          return {
            id: m.id,
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
            actions,
            applied_action_indexes: Array.isArray(m.applied_action_indexes)
              ? (m.applied_action_indexes as number[])
              : [],
            created_at: m.created_at,
          };
        });

      const { data: stateRow } = await supabaseAdmin
        .from("folder_chat_state")
        .select("summary")
        .eq("folder_id", data.folder_id)
        .maybeSingle();

      return { messages, summary: stateRow?.summary ?? "" };
    },
  );



type ApplyResultItem = {
  action: FolderChatAction;
  ok: boolean;
  error?: string;
};

export const applyFolderChanges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      folder_id: string;
      actions: FolderChatAction[];
      message_id?: string;
      applied_indexes?: number[];
    }) =>
      z
        .object({
          folder_id: z.string().uuid(),
          actions: z.array(actionInputSchema).min(1).max(20),
          // Optional: the assistant message these actions came from, plus which
          // of that message's action indexes were approved. Used to record the
          // persistent "changes already applied" memory.
          message_id: z.string().uuid().optional(),
          applied_indexes: z.array(z.number().int().min(0).max(19)).max(20).optional(),
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
            action.op === "domain_in"
              ? // Allowlist: normalize to a deduped, comma-separated set of bare domains.
                Array.from(
                  new Set(
                    action.value
                      .split(/[\s,;]+/)
                      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
                      .filter(Boolean),
                  ),
                ).join(",")
              : action.field === "subject"
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

    // Record the persistent applied-changes log on the originating assistant
    // message (merge with any previously applied indexes), best-effort.
    const anyApplied = results.some((r) => r.ok);
    if (data.message_id && data.applied_indexes && data.applied_indexes.length > 0 && anyApplied) {
      try {
        const { data: msgRow } = await supabaseAdmin
          .from("folder_chat_messages")
          .select("id, applied_action_indexes")
          .eq("id", data.message_id)
          .eq("folder_id", data.folder_id)
          .eq("user_id", userId)
          .maybeSingle();
        if (msgRow) {
          const existing = Array.isArray(msgRow.applied_action_indexes)
            ? (msgRow.applied_action_indexes as number[])
            : [];
          const merged = Array.from(new Set([...existing, ...data.applied_indexes])).sort(
            (a, b) => a - b,
          );
          await supabaseAdmin
            .from("folder_chat_messages")
            .update({ applied_action_indexes: merged })
            .eq("id", data.message_id);
        }
      } catch (err: unknown) {
        console.error(
          "record applied indexes failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return { results };
  });

// Clamp/normalize the AI-proposed settings patch to safe DB values.
function buildSettingsPatch(
  s: Extract<FolderChatAction, { type: "update_folder_settings" }>["settings"],
): FolderUpdate {
  const patch: FolderUpdate = {};
  if (s.name !== undefined) patch.name = s.name.trim();
  if (s.color !== undefined) patch.color = s.color;
  if (s.priority !== undefined)
    patch.priority = Math.max(0, Math.min(1000, Math.round(s.priority)));
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
