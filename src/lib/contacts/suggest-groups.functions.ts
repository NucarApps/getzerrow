import { createServerFn } from "@tanstack/react-start";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway";
import { logInfo } from "@/lib/log.server";

type DB = SupabaseClient<Database>;

const MAX_DEPTH = 4;
const RESCAN_COOLDOWN_MS = 5 * 60 * 1000;

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
      rationale: z.string().nullable(),
      kind: z.enum(["new", "subgroup", "merge_into_existing"]),
      parent_group_name: z.string().nullable(),
      existing_group_name: z.string().nullable(),
      // Contacts are referenced by the short `i` index we send in the prompt,
      // not by UUID — models reliably echo small ints, not long UUIDs.
      contact_ids: z.array(z.number().int().positive()),
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

async function loadLatestSuggestions(
  supabase: DB,
  userId: string,
): Promise<SuggestionView[]> {
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
      "id,run_id,name,parent_group_id,existing_group_id,contact_ids,rationale,kind,status,created_at",
    )
    .eq("user_id", userId)
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (rowsErr) throw new Error(rowsErr.message);
  const suggestions = (rows ?? []) as SuggestionRow[];

  const allIds = Array.from(
    new Set(suggestions.flatMap((s) => (s.contact_ids ?? []).slice(0, 5))),
  );
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

/** Kick off a new AI analysis over the user's contacts. Rate limited. */
export const runContactGroupSuggestions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    // Rate limit: at most one scan per 5 minutes.
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
        throw new Error(
          `Please wait ${wait}s before running another AI scan.`,
        );
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
          .order("created_at", { ascending: false })
          .limit(1500),
        supabase
          .from("contact_groups")
          .select("id,name,parent_group_id"),
        supabase.from("contact_group_members").select("contact_id,group_id"),
      ]);
    if (cErr) throw new Error(cErr.message);
    if (!contacts || contacts.length === 0) {
      return { suggestions: [] as SuggestionView[] };
    }

    const groupsById = new Map(
      (groups ?? []).map((g) => [g.id, g] as const),
    );
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
    const idByIndex = new Map<number, string>();
    const contactLines = contacts.map((c, idx) => {
      const i = idx + 1;
      idByIndex.set(i, c.id);
      const domain = emailDomain(c.email);
      const groupNames = (memberGroupsByContact.get(c.id) ?? [])
        .map((gid) => groupsById.get(gid)?.name)
        .filter((v): v is string => !!v);
      return {
        i,
        n: firstNonEmpty(c.name),
        co: firstNonEmpty(c.company),
        t: firstNonEmpty(c.title),
        d: domain,
        city: firstNonEmpty(c.city),
        src: c.source ?? null,
        g: groupNames,
      };
    });

    const existingGroupsPayload = (groups ?? []).map((g) => ({
      name: g.name,
      parent: g.parent_group_id ? groupsById.get(g.parent_group_id)?.name ?? null : null,
      size: groupSizes.get(g.id) ?? 0,
    }));

    const gateway = createLovableAiGatewayProvider(apiKey);
    const model = gateway("google/gemini-3.5-flash");

    const prompt = `You are helping organize a user's contact list into meaningful groups.

Existing groups (do not duplicate):
${JSON.stringify(existingGroupsPayload)}

Contacts (id, n=name, co=company, t=title, d=email domain, city, src=source, g=current groups):
${JSON.stringify(contactLines)}

Task: propose between 3 and 15 new groups (or subgroups) that would help the user organize this list.
Rules:
- Each suggestion must include at least 3 contact_ids from the list above.
- Prefer clustering by company/employer, then by industry/domain, role, or city.
- Use "subgroup" kind and set parent_group_name to an EXISTING group name when the cluster fits under one (e.g., a company inside a broader group), especially when that parent has more than 25 members.
- Use "merge_into_existing" kind with existing_group_name when the suggestion is really about adding contacts to an already-present group.
- Otherwise use "new".
- Do not repeat an existing group name.
- Keep names concise (1-4 words), no emoji.
- rationale: one short sentence explaining the cluster.
Return JSON matching the schema. Do NOT include contacts outside the provided list.`;

    let parsed: z.infer<typeof AiOutput>;
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
        } catch {
          return { suggestions: [] as SuggestionView[] };
        }
      } else {
        throw error;
      }
    }

    const validContactIds = new Set(contacts.map((c) => c.id));
    const groupByLowerName = new Map(
      (groups ?? []).map((g) => [g.name.toLowerCase(), g] as const),
    );

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
    }[] = [];

    for (const s of parsed.suggestions) {
      const cleanName = (s.name ?? "").trim();
      if (!cleanName) continue;
      const ids = (s.contact_ids ?? []).filter((id) => validContactIds.has(id));
      if (ids.length < 3) continue;

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

      rowsToInsert.push({
        user_id: userId,
        run_id: runId,
        name: cleanName.slice(0, 60),
        parent_group_id: parentGroupId,
        existing_group_id: existingGroupId,
        contact_ids: ids,
        rationale: (s.rationale ?? "").trim().slice(0, 500) || null,
        kind,
        status: "pending",
      });
    }

    if (rowsToInsert.length > 0) {
      const { error: insErr } = await supabase
        .from("contact_group_suggestions")
        .insert(rowsToInsert);
      if (insErr) throw new Error(insErr.message);
    }

    const suggestions = await loadLatestSuggestions(supabase, userId);
    return { suggestions };
  });

/** Apply a suggestion: create the group (or use existing) and add contacts. */
export const applyContactGroupSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; group_name_override?: string; target_group_id?: string | null }) =>
    z
      .object({
        id: z.string().uuid(),
        group_name_override: z.string().min(1).max(60).optional(),
        target_group_id: z.string().uuid().nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: row, error: rErr } = await supabase
      .from("contact_group_suggestions")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (rErr) throw new Error(rErr.message);
    if (!row || row.user_id !== userId) throw new Error("Suggestion not found");
    if (row.status !== "pending") throw new Error("Already handled");

    let groupId: string | null = data.target_group_id ?? row.existing_group_id;

    if (!groupId) {
      const uid =
        "group-" +
        (globalThis.crypto?.randomUUID?.() ??
          `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const { data: created, error: cErr } = await supabase
        .from("contact_groups")
        .insert({
          user_id: userId,
          name: (data.group_name_override ?? row.name).trim(),
          color: "#6366f1",
          carddav_uid: uid,
          parent_group_id: row.parent_group_id,
        })
        .select("id")
        .single();
      if (cErr) throw new Error(cErr.message);
      groupId = created.id;
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
      .update({ status: "accepted" })
      .eq("id", data.id);

    return { ok: true, group_id: groupId, added: ids.length };
  });

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
