import { createServerFn } from "@tanstack/react-start";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway";
import { logInfo } from "@/lib/log.server";
import { getEmailsDecrypted, searchEmailsParticipantsDecrypted } from "@/lib/sync/encrypted-reader";
import { normalizeCompanyName } from "./company-name";

type DB = SupabaseClient<Database>;

const MAX_DEPTH = 4;
const RESCAN_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_CONTACTS_FOR_TOPICS = 60;
const EMAILS_PER_CONTACT_FOR_TOPICS = 3;
const TOPIC_SNIPPET_CHARS = 180;

type SuggestionKind = "new" | "subgroup" | "merge_into_existing";

type SuggestionRow = {
  id: string;
  run_id: string;
  name: string;
  parent_group_id: string | null;
  existing_group_id: string | null;
  contact_ids: string[];
  rationale: string | null;
  kind: string;
  status: string;
  created_at: string;
  confidence: string | null;
  auto_applied: boolean | null;
};

type ContactPreview = { id: string; name: string | null; email: string | null };

export type SuggestionView = SuggestionRow & {
  contact_previews: ContactPreview[];
  total_contacts: number;
};

const AiOutput = z.object({
  suggestions: z.array(
    z.object({
      name: z.string(),
      rationale: z.string().nullish(),
      kind: z.enum(["new", "subgroup", "merge_into_existing"]),
      parent_group_name: z.string().nullish(),
      existing_group_name: z.string().nullish(),
      // Contacts are referenced by the short `i` index we send in the prompt,
      // not by UUID — models reliably echo small ints, not long UUIDs.
      contact_ids: z.array(z.number().int().positive()),
      // Model self-assessment. NEVER sufficient for auto-apply on its own —
      // the deterministic evidence gate (suggestion-confidence.ts) decides;
      // AI confidence can only veto.
      confidence: z.enum(["high", "medium", "low"]).nullish(),
    }),
  ),
});

function firstNonEmpty(...vals: (string | null | undefined)[]): string | null {
  for (const v of vals) {
    if (v && v.trim().length > 0) return v.trim();
  }
  return null;
}

function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

async function loadLatestSuggestions(supabase: DB, userId: string): Promise<SuggestionView[]> {
  const { data: latest, error: latestErr } = await supabase
    .from("contact_group_suggestions")
    .select("run_id,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (latestErr) throw new Error(latestErr.message);
  if (!latest || latest.length === 0) return [];

  const runId = latest[0].run_id;
  const { data: rows, error: rowsErr } = await supabase
    .from("contact_group_suggestions")
    .select(
      "id,run_id,name,parent_group_id,existing_group_id,contact_ids,rationale,kind,status,created_at,confidence,auto_applied",
    )
    .eq("user_id", userId)
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (rowsErr) throw new Error(rowsErr.message);
  const suggestions = (rows ?? []) as unknown as SuggestionRow[];

  const allIds = Array.from(new Set(suggestions.flatMap((s) => (s.contact_ids ?? []).slice(0, 5))));
  const previewsById = new Map<string, ContactPreview>();
  if (allIds.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id,name,email")
      .in("id", allIds);
    for (const c of contacts ?? []) {
      previewsById.set(c.id, { id: c.id, name: c.name, email: c.email });
    }
  }

  return suggestions.map((s) => ({
    ...s,
    total_contacts: s.contact_ids?.length ?? 0,
    contact_previews: (s.contact_ids ?? [])
      .slice(0, 5)
      .map((cid) => previewsById.get(cid))
      .filter((v): v is ContactPreview => !!v),
  }));
}

/** Return the most recent AI-generated suggestion run (cached). */
export const getContactGroupSuggestions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const suggestions = await loadLatestSuggestions(supabase, userId);
    return { suggestions };
  });

/** Core of the AI grouping scan. Callable with any client (user-scoped
 * server fn below, or supabaseAdmin from the background enrichment worker),
 * so EVERY query filters on the explicit userId. Rate limited. */
export async function runContactGroupSuggestionsImpl(
  supabase: DB,
  userId: string,
  opts: { source?: "manual" | "background" } = {},
) {
  {
    // Rate limit: at most one scan per 5 minutes. The background 'suggest'
    // job shares this cooldown with the drawer's button — a manual click
    // inside the window returns the cached run instead of erroring, so a
    // cron run minutes earlier never surfaces as "Please wait 240s".
    const { data: last } = await supabase
      .from("contact_group_suggestions")
      .select("created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (last && last.length > 0) {
      const age = Date.now() - new Date(last[0].created_at).getTime();
      if (age < RESCAN_COOLDOWN_MS) {
        const wait = Math.ceil((RESCAN_COOLDOWN_MS - age) / 1000);
        if (opts.source === "background") {
          throw new Error(`Please wait ${wait}s before running another AI scan.`);
        }
        const suggestions = await loadLatestSuggestions(supabase, userId);
        return {
          suggestions,
          stats: {
            cached: true as const,
            cachedAgeSeconds: Math.round(age / 1000),
            cooldownRemainingSeconds: wait,
          },
        };
      }
    }

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("Missing LOVABLE_API_KEY");

    // Load contacts + existing groups.
    const [{ data: contacts, error: cErr }, { data: groups }, { data: memberships }] =
      await Promise.all([
        supabase
          .from("contacts")
          .select("id,name,email,company,title,city,source")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(1500),
        supabase.from("contact_groups").select("id,name,parent_group_id").eq("user_id", userId),
        supabase.from("contact_group_members").select("contact_id,group_id").eq("user_id", userId),
      ]);
    if (cErr) throw new Error(cErr.message);
    if (!contacts || contacts.length === 0) {
      return { suggestions: [] as SuggestionView[] };
    }

    const groupsById = new Map((groups ?? []).map((g) => [g.id, g] as const));
    const memberGroupsByContact = new Map<string, string[]>();
    for (const m of memberships ?? []) {
      const arr = memberGroupsByContact.get(m.contact_id) ?? [];
      arr.push(m.group_id);
      memberGroupsByContact.set(m.contact_id, arr);
    }
    const groupSizes = new Map<string, number>();
    for (const m of memberships ?? []) {
      groupSizes.set(m.group_id, (groupSizes.get(m.group_id) ?? 0) + 1);
    }

    // Compact prompt payload — reference contacts by a short `i` index instead
    // of UUID. Models reliably echo small integers back; UUIDs get hallucinated.
    // Sort ungrouped contacts first so the model sees them at the top of the
    // list and biases suggestions toward covering them.
    const withGroups = (contacts ?? []).map((c) => ({
      c,
      groupNames: (memberGroupsByContact.get(c.id) ?? [])
        .map((gid) => groupsById.get(gid)?.name)
        .filter((v): v is string => !!v),
    }));
    withGroups.sort((a, b) => {
      const au = a.groupNames.length === 0 ? 0 : 1;
      const bu = b.groupNames.length === 0 ? 0 : 1;
      return au - bu;
    });

    // Cap payload: keep every ungrouped contact plus a sample of grouped ones.
    const MAX_PAYLOAD = 800;
    const ungrouped = withGroups.filter((w) => w.groupNames.length === 0);
    const grouped = withGroups.filter((w) => w.groupNames.length > 0);
    const ungroupedTotal = ungrouped.length;
    const groupedSample = grouped.slice(0, Math.max(0, MAX_PAYLOAD - ungrouped.length));
    const payload = [...ungrouped, ...groupedSample];

    const idByIndex = new Map<number, string>();
    const baseLines = payload.map((w, idx) => {
      const i = idx + 1;
      idByIndex.set(i, w.c.id);
      const domain = emailDomain(w.c.email);
      return {
        w,
        i,
        n: firstNonEmpty(w.c.name),
        co: firstNonEmpty(w.c.company),
        t: firstNonEmpty(w.c.title),
        d: domain,
        city: firstNonEmpty(w.c.city),
        src: w.c.source ?? null,
        g: w.groupNames,
        u: w.groupNames.length === 0 ? 1 : 0,
      };
    });

    // Fetch inbox topics so the model can cluster by relationship (vendor,
    // recruiter, investor, personal, etc.), not just shared company/domain.
    // Prioritize ungrouped contacts with an email, dedupe by normalized
    // company so all Honda contacts share one topic blob.
    const topicsByContactIndex = new Map<number, string[]>();
    const topicsByCompanyKey = new Map<string, string[]>();
    const topicCandidates = baseLines
      .filter((l) => l.w.c.email && l.u === 1)
      .concat(baseLines.filter((l) => l.w.c.email && l.u === 0))
      .slice(0, MAX_CONTACTS_FOR_TOPICS);

    const CONCURRENCY = 10;
    let topicsScanned = 0;
    for (let i = 0; i < topicCandidates.length; i += CONCURRENCY) {
      const batch = topicCandidates.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (line) => {
          const email = (line.w.c.email ?? "").toLowerCase();
          if (!email) return;
          const coKey = normalizeCompanyName(line.w.c.company) ?? `d:${line.d ?? ""}`;
          const cached = topicsByCompanyKey.get(coKey);
          if (cached) {
            topicsByContactIndex.set(line.i, cached);
            return;
          }
          try {
            const { rows: hits } = await searchEmailsParticipantsDecrypted({
              userId,
              from: email,
              to: null,
              rest: "",
              limit: EMAILS_PER_CONTACT_FOR_TOPICS,
              offset: 0,
              accountId: null,
            });
            if (!hits || hits.length === 0) return;
            const subjects = hits
              .map((h) => (h.subject ?? "").trim())
              .filter((s) => s.length > 0)
              .slice(0, 3);
            const ids = hits.slice(0, 1).map((h) => h.id);
            let snippet = "";
            if (ids.length > 0) {
              const { rows: bodies } = await getEmailsDecrypted(ids);
              const body = bodies[0];
              snippet = (body?.snippet ?? body?.body_text ?? "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, TOPIC_SNIPPET_CHARS);
            }
            const topics = [...subjects];
            if (snippet) topics.push(snippet);
            if (topics.length === 0) return;
            topicsByCompanyKey.set(coKey, topics);
            topicsByContactIndex.set(line.i, topics);
            topicsScanned++;
          } catch {
            /* best-effort */
          }
        }),
      );
    }

    const contactLines = baseLines.map((l) => ({
      i: l.i,
      n: l.n,
      co: l.co,
      t: l.t,
      d: l.d,
      city: l.city,
      src: l.src,
      g: l.g,
      u: l.u,
      topics: topicsByContactIndex.get(l.i) ?? null,
    }));

    const existingGroupsPayload = (groups ?? []).map((g) => ({
      name: g.name,
      parent: g.parent_group_id ? (groupsById.get(g.parent_group_id)?.name ?? null) : null,
      size: groupSizes.get(g.id) ?? 0,
    }));

    const gateway = createLovableAiGatewayProvider(apiKey);
    const model = gateway("google/gemini-2.5-flash");

    const prompt = `You are helping organize a user's contact list into meaningful groups.

Existing groups (do not duplicate):
${JSON.stringify(existingGroupsPayload)}

Contacts (i=short id, n=name, co=company, t=title, d=email domain, city, src=source, g=current groups, u=1 when ungrouped, topics=recent email subjects/snippets this person is involved in):
${JSON.stringify(contactLines)}

There are ${ungroupedTotal} ungrouped contacts (u=1). ${topicsScanned} contacts have inbox topics attached — use them to infer RELATIONSHIP TYPE (client, vendor/supplier, recruiter, investor, lawyer/accountant, family/personal, service provider, partner, etc.), not just industry.

Task: propose between 3 and 20 groups (new, subgroup, or merge_into_existing).
Rules:
- Reference contacts by their "i" field. Return contact_ids as integers (e.g. [3, 7, 12]). Never invent an "i" that isn't in the list.
- Each suggestion must include at least 2 contact_ids.
- Aim to have at least half your suggested members be ungrouped (u=1) contacts.
- Prefer clusters where the topics agree (e.g. multiple people all sending invoices → "Vendors"; recruiter outreach → "Recruiters"). Fall back to shared company (co), email domain (d), city, or role (t) when topics are sparse.
- Use "subgroup" with parent_group_name = an EXISTING group name when the cluster fits under one (e.g., a company inside a broader relationship group).
- Use "merge_into_existing" with existing_group_name when you're adding contacts to a present group whose theme matches.
- Otherwise use "new".
- Do not repeat an existing group name. Keep names concise (1-4 words), no emoji.
- rationale: one short sentence explaining WHY these contacts belong together (cite topic keywords when relevant).
- confidence: "high" only when the grouping is unambiguous (all members share one company/domain AND the topics agree); "medium" when the pattern is strong but partial; "low" otherwise.
Return JSON matching the schema.`;

    let parsed: z.infer<typeof AiOutput> = { suggestions: [] };
    let parseNote: string | null = null;
    try {
      const { output } = await generateText({
        model,
        output: Output.object({ schema: AiOutput }),
        prompt,
      });
      parsed = output;
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        try {
          parsed = AiOutput.parse(JSON.parse(error.text ?? "{}"));
          parseNote = "recovered_from_raw_text";
        } catch {
          parseNote = "unparseable";
          logInfo("contact_group_suggestions.parse_failed", {
            userId,
            raw_len: error.text?.length ?? 0,
          });
        }
      } else {
        throw error;
      }
    }

    const parsedCount = parsed.suggestions.length;
    let droppedMissingIds = 0;
    let droppedTooSmall = 0;

    const groupByLowerName = new Map((groups ?? []).map((g) => [g.name.toLowerCase(), g] as const));

    // Depth calculation for parent validation.
    const depthOf = (gid: string | null): number => {
      let depth = 1;
      let cur = gid;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const g = groupsById.get(cur);
        if (!g?.parent_group_id) break;
        depth += 1;
        cur = g.parent_group_id;
        if (depth > MAX_DEPTH + 2) break;
      }
      return depth;
    };

    const runId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
    const rowsToInsert: {
      user_id: string;
      run_id: string;
      name: string;
      parent_group_id: string | null;
      existing_group_id: string | null;
      contact_ids: string[];
      rationale: string | null;
      kind: SuggestionKind;
      status: string;
      confidence: string;
    }[] = [];

    for (const s of parsed.suggestions) {
      const cleanName = (s.name ?? "").trim();
      if (!cleanName) continue;

      // Map short indices back to real UUIDs; drop any index the model invented.
      const rawIds = s.contact_ids ?? [];
      const mappedIds: string[] = [];
      const seen = new Set<string>();
      for (const i of rawIds) {
        const cid = idByIndex.get(i);
        if (!cid) {
          droppedMissingIds++;
          continue;
        }
        if (seen.has(cid)) continue;
        seen.add(cid);
        mappedIds.push(cid);
      }

      let kind: SuggestionKind = s.kind ?? "new";
      let existingGroupId: string | null = null;
      let parentGroupId: string | null = null;

      if (kind === "merge_into_existing" && s.existing_group_name) {
        const g = groupByLowerName.get(s.existing_group_name.toLowerCase());
        if (g) existingGroupId = g.id;
        else kind = "new";
      }

      if (kind === "subgroup" && s.parent_group_name) {
        const g = groupByLowerName.get(s.parent_group_name.toLowerCase());
        if (g && depthOf(g.id) + 1 <= MAX_DEPTH) parentGroupId = g.id;
        else kind = "new";
      }

      if (kind === "new" && groupByLowerName.has(cleanName.toLowerCase())) {
        // Would duplicate — convert to merge.
        const g = groupByLowerName.get(cleanName.toLowerCase())!;
        kind = "merge_into_existing";
        existingGroupId = g.id;
      }

      // Loosened: 2 members is a real cluster; new groups also 2 minimum.
      const minMembers = 2;
      if (mappedIds.length < minMembers) {
        droppedTooSmall++;
        continue;
      }

      rowsToInsert.push({
        user_id: userId,
        run_id: runId,
        name: cleanName.slice(0, 60),
        parent_group_id: parentGroupId,
        existing_group_id: existingGroupId,
        contact_ids: mappedIds,
        rationale: (s.rationale ?? "").trim().slice(0, 500) || null,
        kind,
        status: "pending",
        confidence: s.confidence ?? "low",
      });
    }

    // Cap at 20 to keep the drawer usable.
    const capped = rowsToInsert.slice(0, 20);

    if (capped.length > 0) {
      const { error: insErr } = await supabase
        .from("contact_group_suggestions")
        .insert(capped as never[]);
      if (insErr) throw new Error(insErr.message);
    }

    logInfo("contact_group_suggestions.run_complete", {
      userId,
      run_id: runId,
      parsed_count: parsedCount,
      kept_count: capped.length,
      dropped_missing_ids: droppedMissingIds,
      dropped_too_small: droppedTooSmall,
      parse_note: parseNote,
      contact_pool: contacts.length,
      ungrouped_total: ungroupedTotal,
      topics_scanned: topicsScanned,
    });

    const suggestions = await loadLatestSuggestions(supabase, userId);
    return {
      suggestions,
      stats: {
        parsed: parsedCount,
        kept: capped.length,
        inserted: capped.length,
        droppedMissingIds,
        droppedTooSmall,
        parseNote,
        contactPool: contacts.length,
        ungroupedTotal,
        topicsScanned,
      },
    };
  }
}

/** Kick off a new AI analysis over the user's contacts. Rate limited. */
export const runContactGroupSuggestions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => runContactGroupSuggestionsImpl(context.supabase, context.userId));

/** Apply a suggestion: create the group (or use existing) and add contacts. */
/** Core of suggestion apply — shared by the user-facing server fn and the
 * background auto-apply gate. Every query filters on userId (callers may
 * pass supabaseAdmin). */
export async function applySuggestionImpl(
  supabase: DB,
  userId: string,
  args: {
    id: string;
    group_name_override?: string;
    target_group_id?: string | null;
    /** Mark the suggestion as applied by the background gate, with the
     * deterministic evidence that justified it. */
    autoApplied?: boolean;
    evidence?: Record<string, unknown> | null;
  },
): Promise<{ ok: true; group_id: string | null; added: number }> {
  const { data: row, error: rErr } = await supabase
    .from("contact_group_suggestions")
    .select("*")
    .eq("id", args.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (rErr) throw new Error(rErr.message);
  if (!row) throw new Error("Suggestion not found");
  if (row.status !== "pending") throw new Error("Already handled");

  let groupId: string | null = args.target_group_id ?? row.existing_group_id;

  if (!groupId) {
    // Shared resolver: an accepted suggestion for "Nissan, Inc." lands on
    // an existing "Nissan" label instead of creating a duplicate.
    const { resolveOrCreateCompanyLabel } = await import("./label-resolve.server");
    const resolved = await resolveOrCreateCompanyLabel(
      { supabase, userId },
      {
        rawName: (args.group_name_override ?? row.name).trim(),
        parentGroupId: row.parent_group_id,
      },
    );
    if (!resolved) throw new Error("Suggestion name is empty");
    groupId = resolved.id;
  }

  const ids: string[] = row.contact_ids ?? [];
  if (ids.length > 0 && groupId) {
    const rows = ids.map((cid) => ({
      user_id: userId,
      group_id: groupId!,
      contact_id: cid,
    }));
    const { error: mErr } = await supabase
      .from("contact_group_members")
      .upsert(rows, { onConflict: "group_id,contact_id", ignoreDuplicates: true });
    if (mErr) throw new Error(mErr.message);
  }

  await supabase
    .from("contact_group_suggestions")
    .update({
      status: "accepted",
      ...(args.autoApplied ? { auto_applied: true, evidence: args.evidence ?? null } : {}),
    } as never)
    .eq("id", args.id)
    .eq("user_id", userId);

  // Converge auto company subgroups if the target label has them enabled —
  // every other membership-add path does this (contact-groups / group-rules),
  // so applied AI suggestions must too or the subgroups go stale.
  if (groupId) {
    const { reconcileIfAuto } = await import("./auto-company-subgroups.functions");
    await reconcileIfAuto(supabase, userId, groupId);
  }

  return { ok: true, group_id: groupId, added: ids.length };
}

export const applyContactGroupSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { id: string; group_name_override?: string; target_group_id?: string | null }) =>
      z
        .object({
          id: z.string().uuid(),
          group_name_override: z.string().min(1).max(60).optional(),
          target_group_id: z.string().uuid().nullable().optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) =>
    applySuggestionImpl(context.supabase, context.userId, data),
  );

export const dismissContactGroupSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("contact_group_suggestions")
      .update({ status: "dismissed" })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
