// AI-assisted contact duplicate detection. Server-side only.
import { createServerFn } from "@tanstack/react-start";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway";
import { normalizePhone } from "./phone";

type ContactRow = {
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  title: string | null;
  city: string | null;
  source: string | null;
  created_at: string;
};

type PhoneRow = { contact_id: string; number: string };

type ContactWithPhones = ContactRow & { phones: string[] };

const MAX_CLUSTERS = 50; // safety cap for AI credits per scan
const MAX_CLUSTER_SIZE = 6; // clusters bigger than this are truncated for the prompt

type Cluster = {
  key: string;
  contacts: ContactWithPhones[];
  signal: "exact_phone" | "name_phone" | "name_company" | "name_only";
};

function normName(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function buildClusters(all: ContactWithPhones[]): Cluster[] {
  const byPhone = new Map<string, ContactWithPhones[]>();
  const byNameCompany = new Map<string, ContactWithPhones[]>();
  const byName = new Map<string, ContactWithPhones[]>();

  for (const c of all) {
    const name = normName(c.name);
    const company = normName(c.company);
    for (const raw of c.phones) {
      const n = normalizePhone(raw);
      if (!n) continue;
      const list = byPhone.get(n) ?? [];
      list.push(c);
      byPhone.set(n, list);
    }
    if (name && company) {
      const k = `${name}|${company}`;
      const list = byNameCompany.get(k) ?? [];
      list.push(c);
      byNameCompany.set(k, list);
    }
    if (name) {
      const list = byName.get(name) ?? [];
      list.push(c);
      byName.set(name, list);
    }
  }

  const clusters: Cluster[] = [];
  const seen = new Set<string>();

  function pushCluster(members: ContactWithPhones[], signal: Cluster["signal"], key: string) {
    if (members.length < 2) return;
    // Dedup by ids in the cluster so the same person isn't listed twice.
    const uniq = new Map<string, ContactWithPhones>();
    for (const m of members) uniq.set(m.id, m);
    if (uniq.size < 2) return;
    const idKey = Array.from(uniq.keys()).sort().join(",");
    if (seen.has(idKey)) return;
    seen.add(idKey);
    clusters.push({ key, contacts: Array.from(uniq.values()), signal });
  }

  for (const [k, list] of byPhone) pushCluster(list, "exact_phone", `phone:${k}`);
  for (const [k, list] of byNameCompany) pushCluster(list, "name_company", `nc:${k}`);
  for (const [k, list] of byName) {
    // Skip name-only when everyone in the group shares an email — those are
    // usually the same person already keyed properly.
    const uniqEmails = new Set(list.map((c) => (c.email ?? "").toLowerCase()).filter(Boolean));
    if (uniqEmails.size > 1) pushCluster(list, "name_only", `name:${k}`);
  }
  return clusters;
}

/** Which contact to promote as the "primary" of a merge. */
function pickPrimary(cluster: ContactWithPhones[]): ContactWithPhones {
  const sorted = [...cluster].sort((a, b) => {
    // Prefer rows with an email
    const ae = a.email ? 1 : 0;
    const be = b.email ? 1 : 0;
    if (ae !== be) return be - ae;
    // Then richness (count of non-null fields)
    const score = (c: ContactWithPhones) =>
      [c.name, c.company, c.title, c.city].filter(Boolean).length + c.phones.length;
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sb - sa;
    // Oldest wins as tiebreaker (stable id)
    return a.created_at.localeCompare(b.created_at);
  });
  return sorted[0];
}

const AiSchema = z.object({
  same_person: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string(),
});

type ClusterInput = {
  ids: string[];
  contacts: Array<Pick<ContactWithPhones, "id" | "name" | "email" | "company" | "title" | "city"> & { phones: string[] }>;
};

async function judgeCluster(
  apiKey: string,
  cluster: ClusterInput,
): Promise<z.infer<typeof AiSchema>> {
  const gateway = createLovableAiGatewayProvider(apiKey);
  const model = gateway("google/gemini-3.5-flash");
  const prompt = `You review a small group of contact rows and decide whether they represent the same real person.

Contacts (JSON):
${JSON.stringify(cluster.contacts)}

Return JSON matching the schema:
- same_person: true when they clearly represent the same real person, false otherwise
- confidence: high (strong signals: shared phone or same email prefix + matching name), medium (matching name + company or partial signals), low (only weak clues)
- reason: one short sentence naming the deciding signal(s), max 200 characters.

Rules:
- Two people at the same company with different names are NOT duplicates.
- Different emails on the same phone number is a strong duplicate signal.
- Missing fields shouldn't lower confidence when the fields present match.`;
  try {
    const { output } = await generateText({
      model,
      output: Output.object({ schema: AiSchema }),
      prompt,
    });
    return output;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      try {
        return AiSchema.parse(JSON.parse(error.text ?? "{}"));
      } catch {
        return { same_person: false, confidence: "low", reason: "AI response unparseable" };
      }
    }
    throw error;
  }
}

export type DuplicateSuggestion = {
  id: string;
  primary_contact_id: string;
  duplicate_contact_ids: string[];
  confidence: "high" | "medium" | "low";
  reason: string | null;
  signals: Record<string, unknown>;
  status: "pending" | "merged" | "dismissed";
  created_at: string;
  contacts: Array<ContactWithPhones>;
};

export const scanContactDuplicates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const [{ data: contacts }, { data: phones }] = await Promise.all([
      supabase
        .from("contacts")
        .select("id, name, email, company, title, city, source, created_at")
        .eq("user_id", userId),
      supabase
        .from("contact_phones")
        .select("contact_id, number")
        .eq("user_id", userId),
    ]);

    if (!contacts || contacts.length < 2) {
      return {
        clustersAnalyzed: 0,
        clustersTotal: 0,
        created: 0,
        truncated: false,
      };
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

    // Clear previous pending suggestions before writing new ones so the UI
    // never shows a stale mix.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("contact_duplicate_suggestions")
      .delete()
      .eq("user_id", userId)
      .eq("status", "pending");

    let created = 0;

    for (const cluster of workingSet) {
      const members = cluster.contacts.slice(0, MAX_CLUSTER_SIZE);
      const primary = pickPrimary(members);
      const duplicates = members.filter((c) => c.id !== primary.id);
      if (duplicates.length === 0) continue;

      let confidence: "high" | "medium" | "low";
      let reason: string;
      let samePerson = true;

      // Exact phone match is high confidence without asking the AI.
      if (cluster.signal === "exact_phone") {
        confidence = "high";
        reason = "Shared phone number across rows";
      } else if (!apiKey) {
        // AI unavailable — still record blocking clusters at medium confidence.
        confidence = cluster.signal === "name_company" ? "medium" : "low";
        reason =
          cluster.signal === "name_company"
            ? "Same name and company"
            : "Same name across rows";
      } else {
        const verdict = await judgeCluster(apiKey, {
          ids: members.map((c) => c.id),
          contacts: members.map((c) => ({
            id: c.id,
            name: c.name,
            email: c.email,
            company: c.company,
            title: c.title,
            city: c.city,
            phones: c.phones.map((p) => normalizePhone(p) || p),
          })),
        });
        samePerson = verdict.same_person;
        confidence = verdict.confidence;
        reason = verdict.reason.slice(0, 400);
      }

      if (!samePerson) continue;

      const { error: insErr } = await supabaseAdmin
        .from("contact_duplicate_suggestions")
        .upsert(
          {
            user_id: userId,
            primary_contact_id: primary.id,
            duplicate_contact_ids: duplicates.map((c) => c.id),
            confidence,
            reason,
            signals: { blocking: cluster.signal, key: cluster.key },
            status: "pending",
          },
          { onConflict: "user_id,primary_contact_id" },
        );
      if (!insErr) created++;
    }

    return { clustersAnalyzed: workingSet.length, clustersTotal, created, truncated };
  });

export const listContactDuplicateSuggestions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: rows } = await supabase
      .from("contact_duplicate_suggestions")
      .select("id, primary_contact_id, duplicate_contact_ids, confidence, reason, signals, status, created_at")
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
      signals: Record<string, unknown>;
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

    // Move group memberships (skip conflicts on unique (group_id, contact_id))
    const { data: dupMemberships } = await supabaseAdmin
      .from("contact_group_members")
      .select("group_id, contact_id")
      .in("contact_id", dupIds);
    if (dupMemberships && dupMemberships.length > 0) {
      const { data: primaryMembers } = await supabaseAdmin
        .from("contact_group_members")
        .select("group_id")
        .eq("contact_id", primaryId);
      const already = new Set((primaryMembers ?? []).map((m) => m.group_id));
      const toAdd = Array.from(
        new Set(
          dupMemberships
            .map((m) => m.group_id)
            .filter((g) => !already.has(g)),
        ),
      );
      if (toAdd.length > 0) {
        await supabaseAdmin
          .from("contact_group_members")
          .insert(toAdd.map((g) => ({ group_id: g, contact_id: primaryId })));
      }
      await supabaseAdmin
        .from("contact_group_members")
        .delete()
        .in("contact_id", dupIds);
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
