import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  searchEmailsParticipantsDecrypted,
} from "../sync/encrypted-reader";
import { setContactEncryptedFields } from "../sync/encrypted-writer";
import { normalizePhone } from "./phone";
import {
  firstLastTokens,
  nameMatchConfidence,
  normalizeNameLoose,
  type NameMatchConfidence,
} from "./name-match";

const logInfo = (event: string, payload: Record<string, unknown>) => {
  // eslint-disable-next-line no-console
  console.info(JSON.stringify({ event, ...payload }));
};

const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com",
  "icloud.com", "me.com", "aol.com", "protonmail.com", "proton.me", "live.com",
  "msn.com", "pm.me", "mac.com",
]);

type SuggestionField = "email" | "phone" | "company" | "title";
type Confidence = "high" | "medium" | "low";

type CandidateRow = {
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  title: string | null;
};

const MAX_CONTACTS_PER_RUN = 200;

/** Kick off a scan across contacts and produce enrichment suggestions. */
export const scanContactEnrichment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { strictness?: number } | undefined) =>
    z
      .object({ strictness: z.number().int().min(1).max(5).optional() })
      .default({})
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const userId = context.userId;
    const strictness = data.strictness ?? 3;

    // Candidate contacts: named contacts that are missing email OR company OR title.
    const { data: rawCandidates, error: cErr } = await supabase
      .from("contacts")
      .select("id, name, email, company, title")
      .not("name", "is", null)
      .order("updated_at", { ascending: false })
      .limit(MAX_CONTACTS_PER_RUN * 3);
    if (cErr) throw new Error(cErr.message);
    const candidates: CandidateRow[] = (rawCandidates ?? [])
      .filter(
        (c) =>
          (c.name ?? "").trim().length > 1 &&
          (!c.email || !c.company || !c.title),
      )
      .slice(0, MAX_CONTACTS_PER_RUN);

    if (candidates.length === 0) {
      return {
        scanned: 0,
        created: 0,
        run_id: null as string | null,
      };
    }

    const runId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
    const rows: {
      user_id: string;
      contact_id: string;
      run_id: string;
      field: SuggestionField;
      value: string;
      source: string;
      evidence: string | null;
      confidence: Confidence;
    }[] = [];

    // Existing pending suggestions we should not duplicate.
    const { data: pendingRows } = await supabase
      .from("contact_enrichment_suggestions")
      .select("contact_id, field, value")
      .eq("status", "pending");
    const existing = new Set(
      (pendingRows ?? []).map(
        (r) => `${r.contact_id}|${r.field}|${(r.value ?? "").toLowerCase()}`,
      ),
    );

    // For contacts with an email but missing company: derive from non-personal domain.
    for (const c of candidates) {
      if (c.email && !c.company) {
        const domain = c.email.split("@")[1]?.toLowerCase();
        if (domain && !PERSONAL_DOMAINS.has(domain)) {
          const company = deriveCompanyFromDomain(domain);
          if (company) {
            const key = `${c.id}|company|${company.toLowerCase()}`;
            if (!existing.has(key)) {
              rows.push({
                user_id: userId,
                contact_id: c.id,
                run_id: runId,
                field: "company",
                value: company,
                source: "domain_derived",
                evidence: `Derived from ${c.email}`,
                confidence: "medium",
              });
              existing.add(key);
            }
          }
        }
      }
    }

    // For contacts missing email: search mail participants by name.
    const nameLackingEmail = candidates.filter((c) => !c.email);
    for (const c of nameLackingEmail) {
      const tokens = firstLastTokens(c.name);
      if (!tokens) continue;
      const [first, last] = tokens;
      const query = [first, last].filter(Boolean).join(" ");
      if (!query || query.length < 3) continue;

      const { rows: hits, error: sErr } = await searchEmailsParticipantsDecrypted({
        userId,
        from: query,
        to: null,
        rest: "",
        limit: 12,
        offset: 0,
        accountId: null,
      });
      if (sErr) continue;

      // Group by from_addr; take best match per address.
      const byAddr = new Map<
        string,
        { name: string | null; count: number; confidence: NameMatchConfidence }
      >();
      for (const h of hits) {
        const addr = (h.from_addr ?? "").toLowerCase();
        if (!addr) continue;
        const conf = nameMatchConfidence(c.name, h.from_name, strictness);
        if (!conf) continue;
        const prev = byAddr.get(addr);
        if (!prev) {
          byAddr.set(addr, { name: h.from_name, count: 1, confidence: conf });
        } else {
          prev.count += 1;
          // Upgrade confidence if a later hit is stronger.
          if (rank(conf) > rank(prev.confidence)) prev.confidence = conf;
        }
      }

      for (const [addr, info] of byAddr) {
        // Skip if that email already belongs to another contact of this user.
        const { count } = await supabase
          .from("contacts")
          .select("id", { count: "exact", head: true })
          .eq("email", addr);
        if ((count ?? 0) > 0) continue;

        const key = `${c.id}|email|${addr}`;
        if (existing.has(key)) continue;
        rows.push({
          user_id: userId,
          contact_id: c.id,
          run_id: runId,
          field: "email",
          value: addr,
          source: "email_participant",
          evidence: `Matched "${info.name ?? ""}" · ${info.count} message${info.count === 1 ? "" : "s"}`,
          confidence: info.confidence ?? "low",
        });
        existing.add(key);
      }
    }

    if (rows.length > 0) {
      const { error: insErr } = await supabaseAdmin
        .from("contact_enrichment_suggestions")
        .insert(rows);
      if (insErr) throw new Error(insErr.message);
    }

    logInfo("contact_enrichment.scan_complete", {
      userId,
      run_id: runId,
      scanned: candidates.length,
      created: rows.length,
    });

    return { scanned: candidates.length, created: rows.length, run_id: runId };
  });

function rank(c: NameMatchConfidence): number {
  return c === "high" ? 3 : c === "medium" ? 2 : c === "low" ? 1 : 0;
}

function deriveCompanyFromDomain(domain: string): string | null {
  const trimmed = domain.replace(/^www\./, "").split(".").slice(0, -1).join(" ");
  if (!trimmed) return null;
  const capped = trimmed
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return capped.length > 40 ? null : capped;
}

/** List latest pending suggestions grouped by contact. */
export const listContactEnrichmentSuggestions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("contact_enrichment_suggestions")
      .select(
        "id, contact_id, field, value, source, evidence, confidence, created_at, contacts!inner(id, name, email, company, title)",
      )
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    type ContactMini = {
      id: string;
      name: string | null;
      email: string | null;
      company: string | null;
      title: string | null;
    };
    type Row = {
      id: string;
      contact_id: string;
      field: SuggestionField;
      value: string;
      source: string;
      evidence: string | null;
      confidence: Confidence;
      created_at: string;
      contacts: ContactMini | ContactMini[] | null;
    };

    const grouped = new Map<
      string,
      {
        contact: ContactMini;
        suggestions: Array<Omit<Row, "contacts">>;
      }
    >();
    for (const r of (data as Row[] | null) ?? []) {
      const c = Array.isArray(r.contacts) ? r.contacts[0] : r.contacts;
      if (!c) continue;
      const bucket = grouped.get(r.contact_id) ?? {
        contact: c,
        suggestions: [],
      };
      const { contacts: _c, ...rest } = r;
      void _c;
      bucket.suggestions.push(rest);
      grouped.set(r.contact_id, bucket);
    }
    return Array.from(grouped.values());
  });

/** Apply a single suggestion — writes to the contact row and marks applied. */
export const applyContactEnrichmentSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { suggestionId: string }) =>
    z.object({ suggestionId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: sug, error } = await supabase
      .from("contact_enrichment_suggestions")
      .select("id, contact_id, field, value, status")
      .eq("id", data.suggestionId)
      .single();
    if (error || !sug) throw new Error("Suggestion not found");
    if (sug.status !== "pending") return { applied: false as const };

    if (sug.field === "phone") {
      const normalized = normalizePhone(sug.value) || sug.value;
      await setContactEncryptedFields({
        contact_id: sug.contact_id,
        phone: normalized,
      });
    } else {
      const patch: { email?: string; company?: string; title?: string } = {};
      if (sug.field === "email") patch.email = sug.value.toLowerCase();
      if (sug.field === "company") patch.company = sug.value;
      if (sug.field === "title") patch.title = sug.value;
      const { error: upErr } = await supabase
        .from("contacts")
        .update(patch)
        .eq("id", sug.contact_id);
      if (upErr) throw new Error(upErr.message);
    }

    await supabase
      .from("contact_enrichment_suggestions")
      .update({ status: "applied" })
      .eq("id", sug.id);

    // Dismiss competing pending suggestions for the same field on this contact.
    await supabase
      .from("contact_enrichment_suggestions")
      .update({ status: "dismissed" })
      .eq("contact_id", sug.contact_id)
      .eq("field", sug.field)
      .eq("status", "pending")
      .neq("id", sug.id);

    return { applied: true as const };
  });

/** Dismiss a suggestion without applying it. */
export const dismissContactEnrichmentSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { suggestionId: string }) =>
    z.object({ suggestionId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("contact_enrichment_suggestions")
      .update({ status: "dismissed" })
      .eq("id", data.suggestionId);
    if (error) throw new Error(error.message);
    return { dismissed: true as const };
  });
