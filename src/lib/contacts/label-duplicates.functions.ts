// Server functions for detecting and merging duplicate contact labels
// (a.k.a. contact_groups). Mirrors the pattern in companies.functions.ts
// (findDuplicateCompanies / mergeCluster) but operates on contact_groups.
//
// A "duplicate" is a cluster of labels whose normalized display name
// collides (per user, per parent scope). Optional AI review can further
// fold near-matches like "Volkswagen" ↔ "VW".

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { normalizeCompanyName } from "@/lib/companies/normalize";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway";

type DB = SupabaseClient<Database>;

type LabelLite = {
  id: string;
  name: string;
  parent_group_id: string | null;
  auto_generated_from_group_id: string | null;
  color: string | null;
  carddav_uid: string | null;
  member_count: number;
};

const PARENT_ROOT = "__root__";

function normalizeKey(name: string | null | undefined): string | null {
  return normalizeCompanyName(name ?? "");
}

/** Group labels into duplicate clusters. Deterministic pass: same
 *  normalized name within the same parent scope. */
function clusterLabels(labels: LabelLite[]): LabelLite[][] {
  const buckets = new Map<string, LabelLite[]>();
  for (const l of labels) {
    const key = normalizeKey(l.name);
    if (!key) continue;
    const scope = `${l.parent_group_id ?? PARENT_ROOT}::${key}`;
    const arr = buckets.get(scope) ?? [];
    arr.push(l);
    buckets.set(scope, arr);
  }
  return [...buckets.values()].filter((c) => c.length >= 2);
}

export const findDuplicateLabels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ useAi: z.boolean().optional().default(false) }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const [{ data: groups, error }, { data: members }] = await Promise.all([
      supabase
        .from("contact_groups")
        .select(
          "id,name,parent_group_id,auto_generated_from_group_id,color,carddav_uid",
        )
        .eq("user_id", userId)
        .limit(5000),
      supabase.from("contact_group_members").select("group_id"),
    ]);
    if (error) throw new Error(error.message);
    const counts = new Map<string, number>();
    for (const m of members ?? [])
      counts.set(m.group_id, (counts.get(m.group_id) ?? 0) + 1);
    const lite: LabelLite[] = (groups ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      parent_group_id: g.parent_group_id ?? null,
      auto_generated_from_group_id: g.auto_generated_from_group_id ?? null,
      color: g.color ?? null,
      carddav_uid: g.carddav_uid ?? null,
      member_count: counts.get(g.id) ?? 0,
    }));
    const deterministic = clusterLabels(lite);

    // Pick canonical: most members, tie-break by shortest name (usually the
    // umbrella brand). Prefer non-auto rows over auto-generated ones when
    // ties remain so the manual label survives the merge.
    let clusters = deterministic.map((cluster) => {
      const sorted = [...cluster].sort((a, b) => {
        if (b.member_count !== a.member_count)
          return b.member_count - a.member_count;
        const aAuto = a.auto_generated_from_group_id ? 1 : 0;
        const bAuto = b.auto_generated_from_group_id ? 1 : 0;
        if (aAuto !== bAuto) return aAuto - bAuto;
        return a.name.length - b.name.length;
      });
      const canonical = sorted[0];
      return {
        canonicalId: canonical.id,
        canonicalName: canonical.name,
        parentGroupId: canonical.parent_group_id,
        rationale: "Same normalized name within the same parent label.",
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
          const { generateText, Output, NoObjectGeneratedError } = await import(
            "ai"
          );
          const gateway = createLovableAiGatewayProvider(apiKey);
          const model = gateway("google/gemini-3.1-flash-lite");
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
): Promise<{ movedMembers: number; reparentedChildren: number }> {
  if (sourceId === targetId) return { movedMembers: 0, reparentedChildren: 0 };
  // Verify ownership of both.
  const { data: rows, error } = await supabase
    .from("contact_groups")
    .select("id,user_id")
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
  // Move members (idempotent).
  const { data: srcMembers } = await supabase
    .from("contact_group_members")
    .select("contact_id")
    .eq("group_id", sourceId);
  const movedMembers = (srcMembers ?? []).length;
  if (movedMembers > 0) {
    await supabase.from("contact_group_members").upsert(
      (srcMembers ?? []).map((m) => ({
        user_id: userId,
        group_id: targetId,
        contact_id: m.contact_id,
      })),
      { onConflict: "group_id,contact_id", ignoreDuplicates: true },
    );
    await supabase
      .from("contact_group_members")
      .delete()
      .eq("group_id", sourceId);
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
  return { movedMembers, reparentedChildren: reparented };
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
    for (const sourceId of data.foldIds) {
      if (sourceId === data.canonicalId) continue;
      try {
        const r = await mergeLabelPair(supabase, userId, sourceId, data.canonicalId);
        totalMoved += r.movedMembers;
        merged++;
      } catch {
        failed++;
      }
    }
    return { merged, failed, movedMembers: totalMoved };
  });

/** One-shot bulk consolidation: run the deterministic clusterer and merge
 *  every cluster automatically into its default canonical. Used by the
 *  "Auto-merge duplicates" button when the user trusts the picks. */
export const consolidateLabelDuplicates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [{ data: groups, error }, { data: members }] = await Promise.all([
      supabase
        .from("contact_groups")
        .select(
          "id,name,parent_group_id,auto_generated_from_group_id,color,carddav_uid",
        )
        .eq("user_id", userId),
      supabase.from("contact_group_members").select("group_id"),
    ]);
    if (error) throw new Error(error.message);
    const counts = new Map<string, number>();
    for (const m of members ?? [])
      counts.set(m.group_id, (counts.get(m.group_id) ?? 0) + 1);
    const lite: LabelLite[] = (groups ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      parent_group_id: g.parent_group_id ?? null,
      auto_generated_from_group_id: g.auto_generated_from_group_id ?? null,
      color: g.color ?? null,
      carddav_uid: g.carddav_uid ?? null,
      member_count: counts.get(g.id) ?? 0,
    }));
    const clusters = clusterLabels(lite);
    let mergedClusters = 0;
    let mergedLabels = 0;
    for (const cluster of clusters) {
      const sorted = [...cluster].sort((a, b) => {
        if (b.member_count !== a.member_count)
          return b.member_count - a.member_count;
        const aAuto = a.auto_generated_from_group_id ? 1 : 0;
        const bAuto = b.auto_generated_from_group_id ? 1 : 0;
        if (aAuto !== bAuto) return aAuto - bAuto;
        return a.name.length - b.name.length;
      });
      const canonical = sorted[0];
      for (const src of sorted.slice(1)) {
        try {
          await mergeLabelPair(supabase, userId, src.id, canonical.id);
          mergedLabels++;
        } catch {
          // skip on error, keep going
        }
      }
      mergedClusters++;
    }
    return { mergedClusters, mergedLabels };
  });
