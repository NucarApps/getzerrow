// simulateRule server fn (rules upgrade, task 10): dry-run a draft
// folder + filter set against the caller's recent mail. Deterministic
// only — the pure core reuses matchByFilters; no AI call anywhere.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { validateRuleNode } from "./filter-engine";
import { loadAccountContext } from "./account-context";
import { getEmailsDecrypted } from "./encrypted-reader";
import { simulateAgainstEmails, type SimEmail } from "./simulate-rule";
import type { Folder, Filter, RuleNode } from "./types";

/** Bounds (ReDoS/DoS invariant): the tree goes through validateRuleNode
 * exactly like the save path; flat filters are capped in count and
 * value length; the email window is capped at SIMULATION_EMAIL_CAP. */
export const SIMULATION_EMAIL_CAP = 1000;

const filterSchema = z.object({
  field: z.string().min(1).max(40),
  op: z.string().min(1).max(40),
  value: z.string().max(500),
});

export const simulateRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      account_id: string;
      folder_id?: string | null;
      days: 1 | 7 | 30;
      draft: {
        name: string;
        filter_logic?: "any" | "all";
        filter_tree?: unknown;
        priority?: number;
      };
      filters?: Array<{ field: string; op: string; value: string }>;
    }) =>
      z
        .object({
          account_id: z.string().uuid(),
          folder_id: z.string().uuid().nullish(),
          days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
          draft: z.object({
            name: z.string().min(1).max(120),
            filter_logic: z.enum(["any", "all"]).default("any"),
            filter_tree: z.unknown().nullish(),
            priority: z.number().int().min(-1000).max(1000).default(0),
          }),
          filters: z.array(filterSchema).max(50).default([]),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Ownership: the RLS-scoped client returns nothing for accounts the
    // caller doesn't own.
    const { data: account } = await supabase
      .from("gmail_accounts")
      .select("id")
      .eq("id", data.account_id)
      .maybeSingle();
    if (!account) throw new Error("Account not found");

    // Same bounds gate as the save path — an oversized/malformed tree is
    // rejected with its reason instead of silently matching nothing.
    const tree = (data.draft.filter_tree ?? null) as RuleNode | null;
    if (tree) {
      const v = validateRuleNode(tree);
      if (!v.ok) throw new Error(`Invalid rule tree: ${v.reason}`);
    }

    // Real account config (folders, filters, sender groups) — the draft
    // overlays it so the dry run sees exactly what classify would.
    const ctx = await loadAccountContext(data.account_id, userId);
    const draftId = data.folder_id ?? "00000000-0000-0000-0000-00000000draft";
    const base = ctx.folders.find((f) => f.id === draftId);
    const draftFolder: Folder = {
      // Start from the folder being edited (keeps flags/surface config),
      // fall back to inert defaults for a brand-new draft.
      id: draftId,
      name: data.draft.name,
      gmail_label_id: base?.gmail_label_id ?? null,
      ai_rule: base?.ai_rule ?? null,
      learned_profile: base?.learned_profile ?? null,
      last_learned_at: base?.last_learned_at ?? null,
      auto_archive: base?.auto_archive ?? false,
      auto_mark_read: base?.auto_mark_read ?? false,
      auto_star: base?.auto_star ?? false,
      hide_from_inbox: base?.hide_from_inbox ?? false,
      skip_ai: base?.skip_ai ?? true,
      priority: data.draft.priority,
      gmail_account_id: data.account_id,
      filter_logic: data.draft.filter_logic,
      filter_tree: tree,
      forward_to: base?.forward_to ?? null,
      min_ai_confidence: base?.min_ai_confidence ?? 0,
      snooze_hours: base?.snooze_hours ?? 0,
      overrides_inbox_override: base?.overrides_inbox_override ?? false,
      is_cold_email: base?.is_cold_email ?? false,
      surface_ai_rule: base?.surface_ai_rule ?? null,
      surface_names: base?.surface_names ?? null,
      run_on_threads: base?.run_on_threads ?? false,
    };
    const draftFilters: Filter[] = data.filters.map((f, i) => ({
      id: `draft-filter-${i}`,
      folder_id: draftId,
      field: f.field,
      op: f.op,
      value: f.value,
    }));

    // Last-N-days window, newest first, capped. IDs come from the
    // RLS-scoped client, so the admin decrypt below only ever sees the
    // caller's own mail.
    const cutoff = new Date(Date.now() - data.days * 86_400_000).toISOString();
    const { data: rows, error: rowsErr } = await supabase
      .from("emails")
      .select("id, folder_id, has_attachment")
      .eq("gmail_account_id", data.account_id)
      .gte("received_at", cutoff)
      .order("received_at", { ascending: false })
      .limit(SIMULATION_EMAIL_CAP);
    if (rowsErr) throw new Error(rowsErr.message);
    const ids = (rows ?? []).map((r) => r.id);
    const { rows: decrypted, error: decErr } = await getEmailsDecrypted(ids);
    if (decErr) throw new Error(decErr);
    const byId = new Map(decrypted.map((d) => [d.id, d]));

    const emails: SimEmail[] = (rows ?? []).flatMap((r) => {
      const d = byId.get(r.id);
      if (!d) return [];
      const from = (d.from_addr ?? "").toLowerCase();
      const groupHits = ctx.senderGroups.get(from);
      return [
        {
          id: r.id,
          current_folder_id: r.folder_id ?? null,
          from_addr: d.from_addr ?? "",
          from_name: d.from_name ?? "",
          to_addrs: d.to_addrs ?? "",
          cc: d.cc ?? undefined,
          subject: d.subject ?? "",
          body_text: d.body_text ?? "",
          has_attachment: !!r.has_attachment,
          sender_group_ids: groupHits ? Array.from(groupHits) : [],
        },
      ];
    });

    return simulateAgainstEmails(
      emails,
      { folder: draftFolder, filters: draftFilters },
      { folders: ctx.folders, filters: ctx.filters },
    );
  });
