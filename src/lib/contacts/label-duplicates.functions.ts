// Server functions for detecting and merging duplicate contact labels
// (a.k.a. contact_groups). Mirrors the pattern in companies.functions.ts
// (findDuplicateCompanies / mergeCluster) but operates on contact_groups.
//
// A "duplicate" is a cluster of labels that resolve to the same company
// (via their members' company links), the same alias-resolved company
// name, or the same aggressively-normalized name — per user, per parent
// scope (see label-clusters.ts). Optional AI review can further fold
// near-matches like "Volkswagen" ↔ "VW".

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway";
import {
  clusterLabels,
  sortCanonicalFirst,
  dominantCompany,
  CLUSTER_RATIONALE,
  type LabelClusterInput,
} from "./label-clusters";
import { reconcileAutoParentsForContacts } from "./auto-company-subgroups.functions";
import { bumpResyncNonce } from "@/lib/carddav/settings.functions";

type DB = SupabaseClient<Database>;

type LabelLite = LabelClusterInput & {
  color: string | null;
  carddav_uid: string | null;
};

const PARENT_ROOT = "__root__";

/** Load every label with member counts, its dominant member company, and
 *  the user's merged-name aliases — the inputs the pure clusterer needs. */
async function loadLabelClusterInputs(
  supabase: DB,
  userId: string,
): Promise<{ lite: LabelLite[]; nameAliases: Map<string, string> }> {
  const [
    { data: groups, error },
    { data: members },
    { data: contacts },
    { data: aliasRows },
    { data: companyRows },
  ] = await Promise.all([
    supabase
      .from("contact_groups")
      .select("id,name,parent_group_id,auto_generated_from_group_id,color,carddav_uid")
      .eq("user_id", userId)
      .limit(5000),
    supabase.from("contact_group_members").select("group_id,contact_id"),
    supabase.from("contacts").select("id,company_id").eq("user_id", userId),
    supabase.from("company_name_aliases").select("name_key,company_id").eq("user_id", userId),
    supabase.from("companies").select("id,name").eq("user_id", userId),
  ]);
  if (error) throw new Error(error.message);

  const companyByContact = new Map<string, string | null>(
    ((contacts ?? []) as Array<{ id: string; company_id: string | null }>).map((c) => [
      c.id,
      c.company_id ?? null,
    ]),
  );
  const membersByGroup = new Map<string, string[]>();
  for (const m of (members ?? []) as Array<{ group_id: string; contact_id: string }>) {
    const arr = membersByGroup.get(m.group_id) ?? [];
    arr.push(m.contact_id);
    membersByGroup.set(m.group_id, arr);
  }

  const companyNameById = new Map(
    ((companyRows ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  );
  const nameAliases = new Map<string, string>();
  for (const a of (aliasRows ?? []) as Array<{
    name_key: string;
    company_id: string | null;
  }>) {
    const canonical = a.company_id ? companyNameById.get(a.company_id) : null;
    if (a.name_key && canonical) nameAliases.set(a.name_key, canonical);
  }

  const lite: LabelLite[] = (groups ?? []).map((g) => {
    const memberIds = membersByGroup.get(g.id) ?? [];
    return {
      id: g.id,
      name: g.name,
      parent_group_id: g.parent_group_id ?? null,
      auto_generated_from_group_id: g.auto_generated_from_group_id ?? null,
      color: g.color ?? null,
      carddav_uid: g.carddav_uid ?? null,
      member_count: memberIds.length,
      company_id: dominantCompany(memberIds, companyByContact),
    };
  });
  return { lite, nameAliases };
}

export const findDuplicateLabels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ useAi: z.boolean().optional().default(false) }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { lite, nameAliases } = await loadLabelClusterInputs(supabase, userId);
    const deterministic = clusterLabels(lite, nameAliases);

    const clusters = deterministic.map(({ labels: cluster, reason }) => {
      const sorted = sortCanonicalFirst(cluster);
      const canonical = sorted[0];
      return {
        canonicalId: canonical.id,
        canonicalName: canonical.name,
        parentGroupId: canonical.parent_group_id,
        rationale: CLUSTER_RATIONALE[reason],
        members: cluster.map((c) => ({
          id: c.id,
          name: c.name,
          member_count: c.member_count,
          is_auto: !!c.auto_generated_from_group_id,
          include: c.id !== canonical.id,
        })),
      };
    });

    let aiUsed = false;
    if (data.useAi) {
      // AI pass: look for near-match names within the same parent scope
      // that the deterministic pass missed (e.g. "VW" vs "Volkswagen").
      const seenIds = new Set(clusters.flatMap((c) => c.members.map((m) => m.id)));
      const remaining = lite.filter((l) => !seenIds.has(l.id));
      const byScope = new Map<string, LabelLite[]>();
      for (const l of remaining) {
        const scope = l.parent_group_id ?? PARENT_ROOT;
        const arr = byScope.get(scope) ?? [];
        arr.push(l);
        byScope.set(scope, arr);
      }
      try {
        const apiKey = process.env.LOVABLE_API_KEY;
        if (apiKey) {
          const { generateText, Output, NoObjectGeneratedError } = await import("ai");
          const gateway = createLovableAiGatewayProvider(apiKey);
          const model = gateway("google/gemini-2.5-flash");
          const AiSchema = z.object({
            clusters: z.array(
              z.object({
                canonicalName: z.string(),
                fold: z.array(z.string()),
                rationale: z.string(),
              }),
            ),
          });
          const scopes = [...byScope.entries()]
            .filter(([, arr]) => arr.length >= 2)
            .map(([, arr]) =>
              arr.map((l) => ({ id: l.id, name: l.name, contacts: l.member_count })),
            );
          if (scopes.length > 0) {
            const prompt = `You review clusters of contact labels in a personal CRM and decide which ones refer to the SAME entity so the user can merge them.
Only fold labels that are clearly the same thing (spelling variants, brand initialisms, punctuation differences). Keep legitimately separate entities apart even when they share a brand token.
Return one cluster per merge decision; skip labels that should stand alone.
Label scopes (each array is one parent scope; only fold within a scope):
${JSON.stringify(scopes)}
Return JSON matching the schema; use the ORIGINAL label names in fold[].`;
            try {
              const { output } = await generateText({
                model,
                output: Output.object({ schema: AiSchema }),
                prompt,
              });
              aiUsed = true;
              const nameToLabel = new Map(lite.map((l) => [l.name.toLowerCase(), l]));
              for (const c of output.clusters) {
                const canon = nameToLabel.get(c.canonicalName.toLowerCase());
                const fold = c.fold
                  .map((n) => nameToLabel.get(n.toLowerCase()))
                  .filter((l): l is LabelLite => !!l && l.id !== canon?.id);
                if (!canon || fold.length === 0) continue;
                clusters.push({
                  canonicalId: canon.id,
                  canonicalName: canon.name,
                  parentGroupId: canon.parent_group_id,
                  rationale: c.rationale,
                  members: [canon, ...fold].map((l) => ({
                    id: l.id,
                    name: l.name,
                    member_count: l.member_count,
                    is_auto: !!l.auto_generated_from_group_id,
                    include: l.id !== canon.id,
                  })),
                });
              }
            } catch (e) {
              if (!NoObjectGeneratedError.isInstance(e)) throw e;
            }
          }
        }
      } catch {
        // best-effort AI review
      }
    }

    return { clusters, aiUsed };
  });

async function mergeLabelPair(
  supabase: DB,
  userId: string,
  sourceId: string,
  targetId: string,
): Promise<{
  movedMembers: number;
  reparentedChildren: number;
  movedContactIds: string[];
}> {
  if (sourceId === targetId) return { movedMembers: 0, reparentedChildren: 0, movedContactIds: [] };
  // Verify ownership of both.
  const { data: rows, error } = await supabase
    .from("contact_groups")
    .select("id,user_id,auto_generated_from_group_id")
    .in("id", [sourceId, targetId]);
  if (error) throw new Error(error.message);
  const map = new Map((rows ?? []).map((r) => [r.id, r]));
  if (
    !map.get(sourceId) ||
    !map.get(targetId) ||
    map.get(sourceId)!.user_id !== userId ||
    map.get(targetId)!.user_id !== userId
  ) {
    throw new Error("Label not found");
  }
  // Auto-generated survivors are fully server-managed: moved members join
  // as reconciler-owned rows. Otherwise each row keeps its original
  // source/auto flags so the owning engine keeps managing it.
  const targetIsAuto = !!map.get(targetId)!.auto_generated_from_group_id;
  // Move members (idempotent).
  const { data: srcMembers } = await supabase
    .from("contact_group_members")
    .select("contact_id, auto_added, source")
    .eq("group_id", sourceId);
  const srcRows = (srcMembers ?? []) as Array<{
    contact_id: string;
    auto_added: boolean | null;
    source: string | null;
  }>;
  const movedContactIds = srcRows.map((m) => m.contact_id);
  const movedMembers = movedContactIds.length;
  if (movedMembers > 0) {
    const { error: upErr } = await supabase.from("contact_group_members").upsert(
      srcRows.map((m) => ({
        user_id: userId,
        group_id: targetId,
        contact_id: m.contact_id,
        auto_added: targetIsAuto ? true : !!m.auto_added,
        source: targetIsAuto ? "company_subgroup" : (m.source ?? "manual"),
      })),
      { onConflict: "group_id,contact_id", ignoreDuplicates: true },
    );
    if (upErr) throw new Error(upErr.message);
    const { error: delErr } = await supabase
      .from("contact_group_members")
      .delete()
      .eq("group_id", sourceId);
    if (delErr) throw new Error(delErr.message);
  }
  // Reparent children groups (both structural parent and auto-parent
  // pointers) so nested subgroups follow the survivor.
  let reparented = 0;
  const { data: children1 } = await supabase
    .from("contact_groups")
    .update({ parent_group_id: targetId })
    .eq("user_id", userId)
    .eq("parent_group_id", sourceId)
    .select("id");
  reparented += (children1 ?? []).length;
  const { data: children2 } = await supabase
    .from("contact_groups")
    .update({ auto_generated_from_group_id: targetId })
    .eq("user_id", userId)
    .eq("auto_generated_from_group_id", sourceId)
    .select("id");
  reparented += (children2 ?? []).length;
  // Migrate folder link if the target has none.
  const { data: srcRow } = await supabase
    .from("contact_groups")
    .select("folder_id")
    .eq("id", sourceId)
    .maybeSingle();
  if (srcRow?.folder_id) {
    const { data: tgtRow } = await supabase
      .from("contact_groups")
      .select("folder_id")
      .eq("id", targetId)
      .maybeSingle();
    if (!tgtRow?.folder_id) {
      await supabase
        .from("contact_groups")
        .update({ folder_id: srcRow.folder_id })
        .eq("id", targetId);
    }
    // Re-point any sender_in_group folder filters at the survivor.
    await supabase
      .from("folder_filters")
      .update({ value: targetId })
      .eq("op", "sender_in_group")
      .eq("value", sourceId);
  }
  // Delete source (tombstone trigger takes care of Google/CardDAV cleanup).
  const { error: dErr } = await supabase
    .from("contact_groups")
    .delete()
    .eq("id", sourceId)
    .eq("user_id", userId);
  if (dErr) throw new Error(dErr.message);
  return { movedMembers, reparentedChildren: reparented, movedContactIds };
}

/** Post-merge convergence: let the auto-subgroup reconciler settle the
 *  moved contacts, and bump the CardDAV nonce so iPhones notice deleted
 *  groups promptly. Best-effort — a merge that already committed should
 *  never surface as failed because of follow-up work. */
async function convergeAfterMerges(
  supabase: DB,
  userId: string,
  movedContactIds: string[],
): Promise<void> {
  try {
    if (movedContactIds.length > 0) {
      await reconcileAutoParentsForContacts(supabase, userId, [...new Set(movedContactIds)]);
    }
    await bumpResyncNonce(supabase, userId);
  } catch {
    // Non-fatal.
  }
}

export const mergeLabelCluster = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        canonicalId: z.string().uuid(),
        foldIds: z.array(z.string().uuid()).min(1).max(50),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    let merged = 0;
    let failed = 0;
    let totalMoved = 0;
    const movedContactIds: string[] = [];
    const errors: string[] = [];
    for (const sourceId of data.foldIds) {
      if (sourceId === data.canonicalId) continue;
      try {
        const r = await mergeLabelPair(supabase, userId, sourceId, data.canonicalId);
        totalMoved += r.movedMembers;
        movedContactIds.push(...r.movedContactIds);
        merged++;
      } catch (e) {
        failed++;
        if (errors.length < 3) errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (merged > 0) await convergeAfterMerges(supabase, userId, movedContactIds);
    return { merged, failed, movedMembers: totalMoved, errors };
  });

/** Core of the bulk consolidation, callable with any client (user-scoped
 *  server fn below, or supabaseAdmin from the one-time backfill cron hook). */
export async function consolidateLabelDuplicatesImpl(
  supabase: SupabaseClient,
  userId: string,
): Promise<{
  mergedClusters: number;
  mergedLabels: number;
  failedLabels: number;
  errors: string[];
}> {
  const { lite, nameAliases } = await loadLabelClusterInputs(supabase, userId);
  const clusters = clusterLabels(lite, nameAliases);
  let mergedClusters = 0;
  let mergedLabels = 0;
  let failedLabels = 0;
  const movedContactIds: string[] = [];
  const errors: string[] = [];
  for (const { labels: cluster } of clusters) {
    const sorted = sortCanonicalFirst(cluster);
    const canonical = sorted[0];
    for (const src of sorted.slice(1)) {
      try {
        const r = await mergeLabelPair(supabase, userId, src.id, canonical.id);
        movedContactIds.push(...r.movedContactIds);
        mergedLabels++;
      } catch (e) {
        failedLabels++;
        if (errors.length < 3) errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    mergedClusters++;
  }
  if (mergedLabels > 0) await convergeAfterMerges(supabase, userId, movedContactIds);
  return { mergedClusters, mergedLabels, failedLabels, errors };
}

/** One-shot bulk consolidation: run the deterministic clusterer and merge
 *  every cluster automatically into its default canonical. Used by the
 *  "Auto-merge duplicates" button when the user trusts the picks. */
export const consolidateLabelDuplicates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => consolidateLabelDuplicatesImpl(context.supabase, context.userId));
