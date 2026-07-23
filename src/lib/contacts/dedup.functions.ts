// AI-assisted contact duplicate detection. Server-side only.
import { createServerFn } from "@tanstack/react-start";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway";
import { logInfo } from "@/lib/log.server";
import { normalizePhone } from "./phone";
import {
  buildClusters,
  pickPrimary,
  truncateMembers,
  type Cluster,
  type ContactRow,
  type ContactWithPhones,
  type PhoneRow,
} from "./dedup-clusters";
import { reconcileAutoParentsForContacts } from "./auto-company-subgroups.functions";

const MAX_CLUSTERS = 80; // safety cap for AI credits per scan
const MAX_CLUSTER_SIZE = 6; // clusters bigger than this are truncated for the prompt

const AiSchema = z.object({
  same_person: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string(),
});

type ClusterInput = {
  ids: string[];
  contacts: Array<
    Pick<ContactWithPhones, "id" | "name" | "email" | "company" | "title" | "city"> & {
      phones: string[];
    }
  >;
};

/** Clusters per model call. Batching turns an 80-cluster scan from 80
 * sequential calls (minutes — guaranteed wall-time death when run inline)
 * into ≤10, and lets a whole scan finish inside one background-worker tick. */
const JUDGE_BATCH_SIZE = 8;

const BatchAiSchema = z.object({
  verdicts: z.array(
    z.object({
      cluster: z.number().int().positive(),
      same_person: z.boolean(),
      confidence: z.enum(["high", "medium", "low"]),
      reason: z.string(),
    }),
  ),
});

/** Judge up to JUDGE_BATCH_SIZE clusters in one model call. Returns a map of
 * 1-based cluster index → verdict. A failed call returns an EMPTY map — the
 * caller skips those clusters and keeps going instead of aborting the scan. */
async function judgeClustersBatch(
  apiKey: string,
  clusters: ClusterInput[],
): Promise<Map<number, z.infer<typeof AiSchema>>> {
  const gateway = createLovableAiGatewayProvider(apiKey);
  const model = gateway("google/gemini-2.5-flash");
  const blocks = clusters
    .map((c, idx) => `Cluster ${idx + 1}:\n${JSON.stringify(c.contacts)}`)
    .join("\n\n");
  const prompt = `You review small groups ("clusters") of contact rows and decide, for EACH cluster independently, whether its rows represent the same real person.

${blocks}

Return JSON matching the schema — one verdict per cluster, using the cluster's number:
- same_person: true when the rows clearly represent the same real person, false otherwise
- confidence: high (strong signals: shared phone or same email prefix + matching name), medium (matching name + company or partial signals), low (only weak clues)
- reason: one short sentence naming the deciding signal(s), max 200 characters.

Rules:
- Two people at the same company with different names are NOT duplicates.
- Different emails on the same phone number is a strong duplicate signal.
- Missing fields shouldn't lower confidence when the fields present match.
- Never merge verdicts across clusters; judge each on its own rows only.`;

  const out = new Map<number, z.infer<typeof AiSchema>>();
  let parsed: z.infer<typeof BatchAiSchema> | null = null;
  try {
    const { output } = await generateText({
      model,
      output: Output.object({ schema: BatchAiSchema }),
      prompt,
    });
    parsed = output;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      try {
        parsed = BatchAiSchema.parse(JSON.parse(error.text ?? "{}"));
      } catch {
        // Unparseable raw text — `parsed` stays null and every cluster in
        // this batch is skipped (counted as an AI failure by the caller).
      }
    } else {
      logInfo("contact_dedup.judge_batch_failed", {
        clusters: clusters.length,
        message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      });
      return out;
    }
  }
  for (const v of parsed?.verdicts ?? []) {
    if (v.cluster >= 1 && v.cluster <= clusters.length && !out.has(v.cluster)) {
      out.set(v.cluster, {
        same_person: v.same_person,
        confidence: v.confidence,
        reason: v.reason,
      });
    }
  }
  return out;
}

export type DuplicateSuggestion = {
  id: string;
  primary_contact_id: string;
  duplicate_contact_ids: string[];
  confidence: "high" | "medium" | "low";
  reason: string | null;
  signals: Record<string, string>;
  status: "pending" | "merged" | "dismissed";
  created_at: string;
  contacts: Array<ContactWithPhones>;
};

/** Core duplicate scan — runs in the background worker (contact_enrich_jobs
 * kind 'dedup_scan'), never inline in a request: with the AI judge batched
 * at JUDGE_BATCH_SIZE it still needs up to ~10 model calls. Non-destructive:
 * existing pending suggestions are only pruned AFTER a fully-judged scan,
 * dismissed suggestions are never resurrected, and a failed judge batch
 * skips its clusters instead of aborting the run. */
export async function scanContactDuplicatesImpl(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Deterministic order matters: cluster membership order feeds truncation
  // and the MAX_CLUSTERS slice, and both must be stable across rescans for
  // the dismissed-suggestion guard (keyed by primary) to hold.
  const [{ data: contacts }, { data: phones }] = await Promise.all([
    supabaseAdmin
      .from("contacts")
      .select("id, name, email, company, title, city, source, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    supabaseAdmin.from("contact_phones").select("contact_id, number").eq("user_id", userId),
  ]);

  if (!contacts || contacts.length < 2) {
    return { clustersAnalyzed: 0, clustersTotal: 0, created: 0, truncated: false, aiFailures: 0 };
  }

  const phoneByContact = new Map<string, string[]>();
  for (const p of (phones ?? []) as PhoneRow[]) {
    const list = phoneByContact.get(p.contact_id) ?? [];
    list.push(p.number);
    phoneByContact.set(p.contact_id, list);
  }
  const withPhones: ContactWithPhones[] = (contacts as ContactRow[]).map((c) => ({
    ...c,
    phones: phoneByContact.get(c.id) ?? [],
  }));

  const clusters = buildClusters(withPhones);
  const clustersTotal = clusters.length;
  const truncated = clustersTotal > MAX_CLUSTERS;
  const workingSet = clusters.slice(0, MAX_CLUSTERS);

  const apiKey = process.env.LOVABLE_API_KEY;

  // Existing suggestions by primary contact: dismissed ones must never be
  // re-proposed, and pending ones let us prune stale rows at the end. A
  // primary can have several rows (e.g. one dismissed + one pending), so
  // track the statuses as sets rather than a last-row-wins map.
  const { data: existingRows } = await supabaseAdmin
    .from("contact_duplicate_suggestions")
    .select("primary_contact_id, status")
    .eq("user_id", userId);
  const existing = (existingRows ?? []) as Array<{ primary_contact_id: string; status: string }>;
  const dismissedPrimaries = new Set(
    existing.filter((r) => r.status === "dismissed").map((r) => r.primary_contact_id),
  );
  const pendingPrimaries = new Set(
    existing.filter((r) => r.status === "pending").map((r) => r.primary_contact_id),
  );

  type Judged = {
    cluster: Cluster;
    primary: ContactWithPhones;
    duplicates: ContactWithPhones[];
    verdict: z.infer<typeof AiSchema>;
  };
  const judged: Judged[] = [];
  const needsAi: Array<{
    cluster: Cluster;
    primary: ContactWithPhones;
    duplicates: ContactWithPhones[];
  }> = [];

  for (const cluster of workingSet) {
    const members = truncateMembers(cluster.contacts, MAX_CLUSTER_SIZE);
    const primary = pickPrimary(members);
    const duplicates = members.filter((c) => c.id !== primary.id);
    if (duplicates.length === 0) continue;

    // Deterministic high-confidence signals bypass the AI cost.
    if (cluster.signal === "exact_phone") {
      judged.push({
        cluster,
        primary,
        duplicates,
        verdict: {
          same_person: true,
          confidence: "high",
          reason: "Shared phone number across rows",
        },
      });
    } else if (cluster.signal === "name_email_local") {
      judged.push({
        cluster,
        primary,
        duplicates,
        verdict: {
          same_person: true,
          confidence: "high",
          reason: "Same name and email address prefix",
        },
      });
    } else if (cluster.signal === "email_localpart") {
      judged.push({
        cluster,
        primary,
        duplicates,
        verdict: {
          same_person: true,
          confidence: "medium",
          reason: "Same email prefix on different domains",
        },
      });
    } else if (!apiKey) {
      // AI unavailable — still record blocking clusters at reduced confidence.
      judged.push({
        cluster,
        primary,
        duplicates,
        verdict: {
          same_person: true,
          confidence: cluster.signal === "name_company" ? "medium" : "low",
          reason:
            cluster.signal === "name_company"
              ? "Same name and company"
              : cluster.signal === "loose_name"
                ? "Similar first + last name"
                : "Same name across rows",
        },
      });
    } else {
      needsAi.push({ cluster, primary, duplicates });
    }
  }

  let aiFailures = 0;
  if (apiKey && needsAi.length > 0) {
    for (let i = 0; i < needsAi.length; i += JUDGE_BATCH_SIZE) {
      const batch = needsAi.slice(i, i + JUDGE_BATCH_SIZE);
      const verdicts = await judgeClustersBatch(
        apiKey,
        batch.map(({ cluster, primary, duplicates }) => ({
          ids: [primary, ...duplicates].map((c) => c.id),
          contacts: [primary, ...duplicates].map((c) => ({
            id: c.id,
            name: c.name,
            email: c.email,
            company: c.company,
            title: c.title,
            city: c.city,
            phones: c.phones.map((p) => normalizePhone(p) || p),
          })),
        })),
      );
      batch.forEach((entry, idx) => {
        const verdict = verdicts.get(idx + 1);
        if (!verdict) {
          aiFailures++;
          return;
        }
        judged.push({ ...entry, verdict });
      });
    }
  }

  let created = 0;
  let skippedDismissed = 0;
  const confirmedPrimaryIds = new Set<string>();
  for (const { cluster, primary, duplicates, verdict } of judged) {
    if (!verdict.same_person) continue;
    if (dismissedPrimaries.has(primary.id)) {
      skippedDismissed++;
      continue;
    }
    // Only one pending row per primary fits the partial unique index; a
    // second cluster claiming the same primary this run is dropped.
    if (confirmedPrimaryIds.has(primary.id)) continue;

    // The unique index on (user_id, primary_contact_id) is PARTIAL
    // (WHERE status='pending'), so PostgREST upsert/onConflict can't target
    // it (42P10) — update the existing pending row or insert a fresh one.
    const values = {
      duplicate_contact_ids: duplicates.map((c) => c.id),
      confidence: verdict.confidence,
      reason: verdict.reason.slice(0, 400),
      signals: { blocking: cluster.signal, key: cluster.key },
    };
    const { error: writeErr } = pendingPrimaries.has(primary.id)
      ? await supabaseAdmin
          .from("contact_duplicate_suggestions")
          .update(values)
          .eq("user_id", userId)
          .eq("primary_contact_id", primary.id)
          .eq("status", "pending")
      : await supabaseAdmin.from("contact_duplicate_suggestions").insert({
          ...values,
          user_id: userId,
          primary_contact_id: primary.id,
          status: "pending",
        });
    if (writeErr) {
      logInfo("contact_dedup.write_failed", {
        user_id: userId,
        primary_contact_id: primary.id,
        code: writeErr.code,
        message: writeErr.message.slice(0, 200),
      });
    } else {
      created++;
      confirmedPrimaryIds.add(primary.id);
    }
  }

  // Prune stale pending suggestions LAST, and only after a complete scan —
  // an AI failure or truncated cluster list must never wipe results the
  // user still needs to review.
  if (!truncated && aiFailures === 0) {
    const stalePrimaryIds = (
      (existingRows ?? []) as Array<{
        primary_contact_id: string;
        status: string;
      }>
    )
      .filter((r) => r.status === "pending" && !confirmedPrimaryIds.has(r.primary_contact_id))
      .map((r) => r.primary_contact_id);
    if (stalePrimaryIds.length > 0) {
      await supabaseAdmin
        .from("contact_duplicate_suggestions")
        .delete()
        .eq("user_id", userId)
        .eq("status", "pending")
        .in("primary_contact_id", stalePrimaryIds);
    }
  }

  logInfo("contact_dedup.scan_complete", {
    user_id: userId,
    clusters_total: clustersTotal,
    clusters_analyzed: workingSet.length,
    created,
    skipped_dismissed: skippedDismissed,
    ai_failures: aiFailures,
    truncated,
  });

  return { clustersAnalyzed: workingSet.length, clustersTotal, created, truncated, aiFailures };
}

/** Queue a duplicate scan for the background worker (results land in the
 * suggestions list, which the drawer polls). Running the scan inline was
 * the old design and it timed out — see scanContactDuplicatesImpl. */
export const scanContactDuplicates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { enqueueUserScanJob } = await import("./enrich-jobs.server");
    const r = await enqueueUserScanJob(context.userId, "dedup_scan");
    return { queued: true, alreadyQueued: r.alreadyQueued };
  });

export const listContactDuplicateSuggestions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: rows } = await supabase
      .from("contact_duplicate_suggestions")
      .select(
        "id, primary_contact_id, duplicate_contact_ids, confidence, reason, signals, status, created_at",
      )
      .eq("user_id", userId)
      .eq("status", "pending")
      .order("confidence", { ascending: true })
      .order("created_at", { ascending: false });

    const suggestions = (rows ?? []) as Array<{
      id: string;
      primary_contact_id: string;
      duplicate_contact_ids: string[];
      confidence: "high" | "medium" | "low";
      reason: string | null;
      signals: Record<string, string>;
      status: "pending" | "merged" | "dismissed";
      created_at: string;
    }>;

    const ids = new Set<string>();
    for (const s of suggestions) {
      ids.add(s.primary_contact_id);
      for (const d of s.duplicate_contact_ids) ids.add(d);
    }
    if (ids.size === 0) return { suggestions: [] as DuplicateSuggestion[] };

    const [{ data: contactRows }, { data: phoneRows }] = await Promise.all([
      supabase
        .from("contacts")
        .select("id, name, email, company, title, city, source, created_at")
        .in("id", Array.from(ids)),
      supabase
        .from("contact_phones")
        .select("contact_id, number")
        .in("contact_id", Array.from(ids)),
    ]);
    const phoneByContact = new Map<string, string[]>();
    for (const p of (phoneRows ?? []) as PhoneRow[]) {
      const l = phoneByContact.get(p.contact_id) ?? [];
      l.push(p.number);
      phoneByContact.set(p.contact_id, l);
    }
    const contactById = new Map<string, ContactWithPhones>();
    for (const c of (contactRows ?? []) as ContactRow[]) {
      contactById.set(c.id, { ...c, phones: phoneByContact.get(c.id) ?? [] });
    }

    const enriched: DuplicateSuggestion[] = suggestions.map((s) => ({
      ...s,
      contacts: [s.primary_contact_id, ...s.duplicate_contact_ids]
        .map((id) => contactById.get(id))
        .filter((c): c is ContactWithPhones => !!c),
    }));

    // Confidence order: high, medium, low
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
    enriched.sort((a, b) => order[a.confidence] - order[b.confidence]);
    return { suggestions: enriched };
  });

const MergeInput = z.object({ suggestionId: z.string().uuid() });

export const mergeContactDuplicate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => MergeInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row } = await supabase
      .from("contact_duplicate_suggestions")
      .select("id, primary_contact_id, duplicate_contact_ids, status")
      .eq("id", data.suggestionId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!row) throw new Error("Suggestion not found");
    if (row.status !== "pending") throw new Error("Already resolved");

    const primaryId = row.primary_contact_id as string;
    const dupIds = (row.duplicate_contact_ids as string[]).filter((id) => id !== primaryId);
    if (dupIds.length === 0) throw new Error("No duplicates to merge");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Move phones to primary (best effort — collisions are fine, they just
    // create redundant rows we can dedupe elsewhere).
    await supabaseAdmin
      .from("contact_phones")
      .update({ contact_id: primaryId })
      .in("contact_id", dupIds);

    // Move group memberships onto the primary, then drop the duplicates'.
    // The insert must succeed before the delete — otherwise a failed transfer
    // followed by an unconditional delete silently erases the user's labels.
    // Upsert with ignoreDuplicates so a row the primary already has (or a
    // concurrent writer added) can't fail the whole batch on the PK.
    const { data: dupMemberships } = await supabaseAdmin
      .from("contact_group_members")
      .select("group_id, contact_id")
      .in("contact_id", dupIds);
    if (dupMemberships && dupMemberships.length > 0) {
      const toAdd = Array.from(new Set(dupMemberships.map((m) => m.group_id)));
      if (toAdd.length > 0) {
        const { error: insErr } = await supabaseAdmin.from("contact_group_members").upsert(
          toAdd.map((g) => ({ group_id: g, contact_id: primaryId, user_id: userId })),
          { onConflict: "group_id,contact_id", ignoreDuplicates: true },
        );
        if (insErr) {
          throw new Error(`Failed to move group memberships during merge: ${insErr.message}`);
        }
      }
      const { error: delErr } = await supabaseAdmin
        .from("contact_group_members")
        .delete()
        .in("contact_id", dupIds);
      if (delErr) {
        throw new Error(`Failed to clear duplicate memberships during merge: ${delErr.message}`);
      }
    }

    // Google links: repoint to primary. Uniqueness is (gmail_account_id,
    // contact_id) so drop dup rows that would collide.
    const { data: dupLinks } = await supabaseAdmin
      .from("google_contact_links")
      .select("gmail_account_id, contact_id, resource_name")
      .in("contact_id", dupIds);
    if (dupLinks && dupLinks.length > 0) {
      const { data: primaryLinks } = await supabaseAdmin
        .from("google_contact_links")
        .select("gmail_account_id")
        .eq("contact_id", primaryId);
      const already = new Set((primaryLinks ?? []).map((l) => l.gmail_account_id));
      const safeToMove = dupLinks.filter((l) => !already.has(l.gmail_account_id));
      for (const l of safeToMove) {
        await supabaseAdmin
          .from("google_contact_links")
          .update({ contact_id: primaryId })
          .eq("gmail_account_id", l.gmail_account_id)
          .eq("resource_name", l.resource_name);
      }
    }

    // Finally delete the duplicate contact rows (cascades will clean the rest).
    await supabaseAdmin.from("contacts").delete().in("id", dupIds);

    await supabaseAdmin
      .from("contact_duplicate_suggestions")
      .update({ status: "merged" })
      .eq("id", data.suggestionId);

    // Converge auto company subgroups for the survivor — the merge may have
    // moved it into new company buckets (best-effort, mirrors crud.functions).
    await reconcileAutoParentsForContacts(supabaseAdmin, userId, [primaryId]);

    return { ok: true, merged: dupIds.length };
  });

const DismissInput = z.object({ suggestionId: z.string().uuid() });

export const dismissContactDuplicate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => DismissInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("contact_duplicate_suggestions")
      .update({ status: "dismissed" })
      .eq("id", data.suggestionId)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/* -------------------------------------------------------------------------- */
/* Manual merge (user-driven, per-field primary picker)                        */
/* -------------------------------------------------------------------------- */

const SCALAR_FIELDS = [
  "name",
  "email",
  "title",
  "company",
  "company_id",
  "avatar_url",
  "avatar_source",
  "website",
  "linkedin",
  "twitter",
  "city",
  "region",
  "postal_code",
  "country",
] as const;
type ScalarField = (typeof SCALAR_FIELDS)[number];

export const getContactsMergePayload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ ids: z.array(z.string().uuid()).min(2).max(6) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: rows, error } = await supabase
      .from("contacts")
      .select(
        "id,user_id,name,email,title,company,company_id,avatar_url,avatar_source,website,linkedin,twitter,city,region,postal_code,country,created_at,manual_overrides,source",
      )
      .in("id", data.ids);
    if (error) throw new Error(error.message);
    if (!rows || rows.length !== data.ids.length) throw new Error("Some contacts not found");
    if (rows.some((r) => r.user_id !== userId)) throw new Error("Forbidden");

    const { getContactDecrypted } = await import("@/lib/sync/encrypted-reader");
    const decrypted = await Promise.all(data.ids.map((id) => getContactDecrypted(id)));
    const notesById = new Map<string, string | null>();
    decrypted.forEach((r, i) => notesById.set(data.ids[i], r.row?.notes ?? null));

    const [{ data: phones }, { data: emails }, { data: memberships }, { data: groupRows }] =
      await Promise.all([
        supabase
          .from("contact_phones")
          .select("id,contact_id,label,number,is_primary,position")
          .in("contact_id", data.ids),
        supabase
          .from("contact_emails")
          .select("id,contact_id,label,address,is_primary,position")
          .in("contact_id", data.ids),
        supabase
          .from("contact_group_members")
          .select("contact_id,group_id")
          .in("contact_id", data.ids),
        supabase.from("contact_groups").select("id,name,color").eq("user_id", userId),
      ]);

    return {
      contacts: rows.map((r) => ({ ...r, notes: notesById.get(r.id) ?? null })),
      phones: phones ?? [],
      emails: emails ?? [],
      memberships: memberships ?? [],
      groups: groupRows ?? [],
    };
  });

const ManualMergeInput = z.object({
  primaryId: z.string().uuid(),
  loserIds: z.array(z.string().uuid()).min(1).max(5),
  fields: z.record(z.string(), z.union([z.string(), z.null()])).default({}),
  notesSource: z.string().uuid().nullable().default(null),
  emails: z
    .array(
      z.object({
        label: z.string().max(40),
        address: z.string().max(320),
        is_primary: z.boolean().default(false),
      }),
    )
    .max(20),
  phones: z
    .array(
      z.object({
        label: z.string().max(40),
        number: z.string().max(64),
        is_primary: z.boolean().default(false),
      }),
    )
    .max(20),
  excludedGroupIds: z.array(z.string().uuid()).default([]),
  manualLockFields: z.array(z.string()).default([]),
});

export type ManualMergeInputType = z.infer<typeof ManualMergeInput>;

export const mergeContactsManual = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ManualMergeInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    if (data.loserIds.includes(data.primaryId)) {
      throw new Error("Primary cannot also be a loser");
    }
    const allIds = [data.primaryId, ...data.loserIds];

    // Verify ownership of all contacts.
    const { data: ownershipRows, error: ownErr } = await supabase
      .from("contacts")
      .select("id,user_id,manual_overrides")
      .in("id", allIds);
    if (ownErr) throw new Error(ownErr.message);
    if (!ownershipRows || ownershipRows.length !== allIds.length) {
      throw new Error("Some contacts not found");
    }
    if (ownershipRows.some((r) => r.user_id !== userId)) throw new Error("Forbidden");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 1) Build survivor scalar patch from `fields`.
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data.fields)) {
      if (!SCALAR_FIELDS.includes(k as ScalarField)) continue;
      patch[k] = v ?? null;
    }

    // Merge manual_overrides so enrichment respects the user's picks.
    const primaryOverridesRow = ownershipRows.find((r) => r.id === data.primaryId) as {
      manual_overrides?: string[] | null;
    };
    const prevOverrides = new Set(primaryOverridesRow?.manual_overrides ?? []);
    for (const f of data.manualLockFields) prevOverrides.add(f);
    if ("company" in patch || "company_id" in patch) {
      prevOverrides.add("company");
    }
    patch.manual_overrides = Array.from(prevOverrides);

    if (Object.keys(patch).length > 0) {
      const { error: updErr } = await supabaseAdmin
        .from("contacts")
        .update(patch as never)
        .eq("id", data.primaryId);
      if (updErr) throw new Error(`Failed to update survivor: ${updErr.message}`);
    }

    // 2) Notes — pull from chosen source and re-encrypt onto survivor.
    if (data.notesSource && data.notesSource !== data.primaryId) {
      const { getContactDecrypted } = await import("@/lib/sync/encrypted-reader");
      const src = await getContactDecrypted(data.notesSource);
      if (src.row) {
        const { setContactEncryptedFields } = await import("@/lib/sync/encrypted-writer");
        await setContactEncryptedFields({
          contact_id: data.primaryId,
          notes: src.row.notes ?? null,
        });
      }
    }

    // 3) Emails / phones — replace-all on survivor with user-chosen set.
    {
      const { error: delErr } = await supabaseAdmin
        .from("contact_emails")
        .delete()
        .eq("user_id", userId)
        .in("contact_id", allIds);
      if (delErr) throw new Error(`Failed to clear emails: ${delErr.message}`);
      if (data.emails.length > 0) {
        const hasPrimary = data.emails.some((e) => e.is_primary);
        const rows = data.emails.map((e, idx) => ({
          user_id: userId,
          contact_id: data.primaryId,
          label: e.label.trim().toLowerCase() || "other",
          address: e.address.trim().toLowerCase(),
          is_primary: hasPrimary ? e.is_primary : idx === 0,
          position: idx,
        }));
        const { error: insErr } = await supabaseAdmin.from("contact_emails").insert(rows);
        if (insErr) throw new Error(`Failed to insert emails: ${insErr.message}`);
      }
    }
    {
      const { error: delErr } = await supabaseAdmin
        .from("contact_phones")
        .delete()
        .eq("user_id", userId)
        .in("contact_id", allIds);
      if (delErr) throw new Error(`Failed to clear phones: ${delErr.message}`);
      if (data.phones.length > 0) {
        const hasPrimary = data.phones.some((p) => p.is_primary);
        const rows = data.phones.map((p, idx) => ({
          user_id: userId,
          contact_id: data.primaryId,
          label: p.label.trim().toLowerCase() || "other",
          number: p.number.trim(),
          is_primary: hasPrimary ? p.is_primary : idx === 0,
          position: idx,
        }));
        const { error: insErr } = await supabaseAdmin.from("contact_phones").insert(rows);
        if (insErr) throw new Error(`Failed to insert phones: ${insErr.message}`);
      }
    }

    // Reflect primary email onto contacts.email for legacy queries.
    const primaryEmail = data.emails.find((e) => e.is_primary)?.address ?? data.emails[0]?.address;
    if (primaryEmail !== undefined) {
      await supabaseAdmin
        .from("contacts")
        .update({ email: primaryEmail ?? null } as never)
        .eq("id", data.primaryId);
    }

    // 4) Group memberships — union losers → survivor, minus excludes.
    const excluded = new Set(data.excludedGroupIds);
    const { data: dupMemberships } = await supabaseAdmin
      .from("contact_group_members")
      .select("group_id, contact_id")
      .in("contact_id", data.loserIds);
    if (dupMemberships && dupMemberships.length > 0) {
      const toAdd = Array.from(
        new Set(dupMemberships.map((m) => m.group_id).filter((g) => !excluded.has(g))),
      );
      if (toAdd.length > 0) {
        const { error: insErr } = await supabaseAdmin.from("contact_group_members").upsert(
          toAdd.map((g) => ({ group_id: g, contact_id: data.primaryId, user_id: userId })),
          { onConflict: "group_id,contact_id", ignoreDuplicates: true },
        );
        if (insErr) throw new Error(`Failed to move memberships: ${insErr.message}`);
      }
    }
    // Also drop any excluded groups from the survivor itself.
    if (excluded.size > 0) {
      await supabaseAdmin
        .from("contact_group_members")
        .delete()
        .eq("contact_id", data.primaryId)
        .in("group_id", Array.from(excluded));
    }

    // 5) Reassign non-cascaded contact_id references to survivor.
    for (const table of ["contact_revisions", "contact_cards_sent"] as const) {
      const { error: reErr } = await supabaseAdmin
        .from(table)
        .update({ contact_id: data.primaryId } as never)
        .in("contact_id", data.loserIds);
      if (reErr) throw new Error(`Failed to reassign ${table}: ${reErr.message}`);
    }

    // 6) Google links — reassign to survivor, drop collisions.
    const { data: dupLinks } = await supabaseAdmin
      .from("google_contact_links")
      .select("gmail_account_id, contact_id, resource_name")
      .in("contact_id", data.loserIds);
    const loserGoogleResources: Array<{ gmail_account_id: string; resource_name: string }> = [];
    if (dupLinks && dupLinks.length > 0) {
      const { data: primaryLinks } = await supabaseAdmin
        .from("google_contact_links")
        .select("gmail_account_id")
        .eq("contact_id", data.primaryId);
      const already = new Set((primaryLinks ?? []).map((l) => l.gmail_account_id));
      for (const l of dupLinks) {
        if (already.has(l.gmail_account_id)) {
          // Collision — this link would be redundant; drop it so the merge
          // deletes cleanly and tombstone push handles the Google side.
          // Only COLLISION resources are tombstoned: a link that gets
          // reassigned to the survivor below is now the survivor's live
          // Google representation — tombstoning it would delete the
          // survivor from Google Contacts.
          loserGoogleResources.push({
            gmail_account_id: l.gmail_account_id,
            resource_name: l.resource_name,
          });
          await supabaseAdmin
            .from("google_contact_links")
            .delete()
            .eq("gmail_account_id", l.gmail_account_id)
            .eq("resource_name", l.resource_name);
        } else {
          await supabaseAdmin
            .from("google_contact_links")
            .update({ contact_id: data.primaryId } as never)
            .eq("gmail_account_id", l.gmail_account_id)
            .eq("resource_name", l.resource_name);
          already.add(l.gmail_account_id);
        }
      }
    }

    // 7) Tombstones — CardDAV per loser id, Google per collision resource.
    if (data.loserIds.length > 0) {
      const { error: cdErr } = await supabaseAdmin.from("carddav_tombstones").upsert(
        data.loserIds.map((id) => ({
          user_id: userId,
          resource_type: "contact",
          resource_id: id,
          deleted_at: new Date().toISOString(),
        })),
        { onConflict: "user_id,resource_type,resource_id" },
      );
      if (cdErr) throw new Error(`Failed to write CardDAV tombstones: ${cdErr.message}`);
    }
    if (loserGoogleResources.length > 0) {
      // kind must be 'contact' — the table CHECK allows ('contact','group')
      // only. This insert used to pass kind:'person' and fail silently on
      // the constraint, so merged Google duplicates were never deleted
      // upstream and resurfaced on the next pull.
      const { error: gErr } = await supabaseAdmin.from("google_contact_tombstones").insert(
        loserGoogleResources.map((r) => ({
          user_id: userId,
          gmail_account_id: r.gmail_account_id,
          kind: "contact",
          resource_name: r.resource_name,
        })),
      );
      if (gErr) throw new Error(`Failed to write Google tombstones: ${gErr.message}`);
    }

    // 8) Delete losers.
    const { error: delErr } = await supabaseAdmin.from("contacts").delete().in("id", data.loserIds);
    if (delErr) throw new Error(`Failed to delete losers: ${delErr.message}`);

    // 9) Bump CardDAV resync so iOS pulls the change.
    {
      const { bumpResyncNonce } = await import("@/lib/carddav/settings.functions");
      await bumpResyncNonce(supabaseAdmin, userId);
    }

    // 10) Reconcile subgroups; mark related suggestions as merged.
    await reconcileAutoParentsForContacts(supabaseAdmin, userId, [data.primaryId]);

    await supabaseAdmin
      .from("contact_duplicate_suggestions")
      .update({ status: "merged" })
      .eq("user_id", userId)
      .eq("primary_contact_id", data.primaryId);
    await supabaseAdmin
      .from("contact_duplicate_suggestions")
      .update({ status: "merged" })
      .eq("user_id", userId)
      .in("primary_contact_id", data.loserIds);

    return { survivorId: data.primaryId, deletedCount: data.loserIds.length };
  });
