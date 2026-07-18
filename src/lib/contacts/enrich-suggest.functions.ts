import { createServerFn } from "@tanstack/react-start";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway";
import {
  getEmailsDecrypted,
  searchEmailsParticipantsDecrypted,
} from "../sync/encrypted-reader";
import { setContactEncryptedFields } from "../sync/encrypted-writer";
import { normalizePhone } from "./phone";
import {
  firstLastTokens,
  nameMatchConfidence,
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

type SuggestionField = "email" | "phone" | "company" | "title" | "name";
type Confidence = "high" | "medium" | "low";

type CandidateRow = {
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  title: string | null;
};

// Cap contacts we ship to AI per scan (each contact costs ~1 gateway call).
const MAX_AI_EXTRACTIONS = 40;
// Total candidate pool (name-search + AI extraction combined).
const MAX_CONTACTS_PER_RUN = 200;
// Emails per contact fed to the extractor.
const EMAILS_PER_CONTACT = 6;
// Trim body text to keep prompts small.
const MAX_BODY_CHARS = 1200;

const SignatureExtraction = z.object({
  name: z.string().nullable(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  phones: z.array(z.string()).nullable(),
  emails: z.array(z.string()).nullable(),
});
type SignatureExtraction = z.infer<typeof SignatureExtraction>;

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

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("Missing LOVABLE_API_KEY");

    // Candidate contacts: anything with an email (we may still find a better
    // name, alt emails, phones, company, or title from their signature), plus
    // named contacts missing an email so we can match by name against inbox
    // senders further down.
    const { data: rawCandidates, error: cErr } = await supabase
      .from("contacts")
      .select("id, name, email, company, title, updated_at")
      .order("updated_at", { ascending: false })
      .limit(MAX_CONTACTS_PER_RUN * 3);
    if (cErr) throw new Error(cErr.message);
    const candidates: CandidateRow[] = (rawCandidates ?? [])
      .filter((c) => !!c.email || (c.name ?? "").trim().length > 1)
      .slice(0, MAX_CONTACTS_PER_RUN);

    if (candidates.length === 0) {
      return { scanned: 0, created: 0, run_id: null as string | null };
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

    // Existing pending + dismissed suggestions we should not duplicate.
    // Dismissed rows count too — the user already said no; don't re-propose them.
    const { data: pendingRows } = await supabase
      .from("contact_enrichment_suggestions")
      .select("contact_id, field, value, source, status")
      .in("status", ["pending", "dismissed"]);
    const existing = new Set(
      (pendingRows ?? []).map(
        (r) => `${r.contact_id}|${r.field}|${(r.value ?? "").toLowerCase()}`,
      ),
    );
    // Hard-mute the domain-derived company guess per contact once dismissed —
    // clearing `contacts.company` would otherwise re-trigger the same guess.
    const dismissedDomainCompany = new Set(
      (pendingRows ?? [])
        .filter(
          (r) =>
            r.status === "dismissed" &&
            r.field === "company" &&
            r.source === "domain_derived",
        )
        .map((r) => r.contact_id),
    );

    // Existing phones per contact so we don't re-suggest numbers already on file.
    const { data: phoneRows } = await supabase
      .from("contact_phones")
      .select("contact_id, number")
      .eq("user_id", userId);
    const phonesByContact = new Map<string, Set<string>>();
    for (const p of (phoneRows ?? []) as Array<{ contact_id: string; number: string }>) {
      const set = phonesByContact.get(p.contact_id) ?? new Set<string>();
      set.add(normalizePhone(p.number) || p.number.toLowerCase());
      phonesByContact.set(p.contact_id, set);
    }

    // ---------- AI signature extraction for candidates WITH an email ----------
    // Any contact with an email is a candidate — the model may find a better
    // name, additional emails, phones, company, or title.
    const withEmail = candidates.filter((c) => !!c.email);
    const forAi = withEmail.slice(0, MAX_AI_EXTRACTIONS);

    // Snapshot of every email already on a contact row so we don't propose
    // an "additional email" that's already someone's primary.
    const { data: allContactEmails } = await supabase
      .from("contacts")
      .select("email")
      .not("email", "is", null);
    const knownEmails = new Set(
      (allContactEmails ?? [])
        .map((r) => (r.email ?? "").toLowerCase())
        .filter(Boolean),
    );

    const gateway = createLovableAiGatewayProvider(apiKey);
    const model = gateway("google/gemini-3.1-flash-lite");
    let aiSuccess = 0;
    let aiEmpty = 0;

    for (const c of forAi) {
      const addr = (c.email ?? "").toLowerCase();
      if (!addr) continue;

      // Find their recent messages by participant.
      const { rows: hits } = await searchEmailsParticipantsDecrypted({
        userId,
        from: addr,
        to: null,
        rest: "",
        limit: EMAILS_PER_CONTACT,
        offset: 0,
        accountId: null,
      });
      if (!hits || hits.length === 0) continue;

      const ids = hits.map((h) => h.id);
      const { rows: bodies } = await getEmailsDecrypted(ids);
      if (bodies.length === 0) continue;

      const corpus = bodies
        .map((b) => {
          const body = (b.body_text ?? b.snippet ?? "").slice(-MAX_BODY_CHARS);
          return `Subject: ${b.subject ?? ""}\nFrom-Name: ${b.from_name ?? ""}\n${body}`;
        })
        .join("\n---\n")
        .slice(0, MAX_BODY_CHARS * 3);

      const prompt = `You are extracting professional identity for one person from the tail of email messages they sent (where signatures live).

Contact on file:
- name: "${c.name ?? ""}"
- primary email: "${addr}"
- company: "${c.company ?? ""}"
- title: "${c.title ?? ""}"

Return JSON with these fields (use null / [] when a field is not clearly present):
- name: the sender's full personal name as it appears in their signature (not a company name)
- company: employer/organization the sender writes for
- title: job title
- phones: array of phone numbers found in a signature (any format)
- emails: array of OTHER email addresses the sender uses (alt/personal/work). Do NOT include the primary email above, quoted reply addresses, or unrelated people.

Only extract facts that clearly belong to THIS sender's own signature (bottom-of-email blocks, "Name | Title | Company" headers, contact cards). Ignore quoted replies, marketing footers, unsubscribe blocks, list-manager addresses, and info about other people in the thread.

Messages:
${corpus}`;

      let extracted: SignatureExtraction | null = null;
      try {
        const { output } = await generateText({
          model,
          output: Output.object({ schema: SignatureExtraction }),
          prompt,
        });
        extracted = output;
      } catch (error) {
        if (NoObjectGeneratedError.isInstance(error)) {
          try {
            extracted = SignatureExtraction.parse(JSON.parse(error.text ?? "{}"));
          } catch {
            extracted = null;
          }
        } else {
          logInfo("contact_enrichment.ai_error", {
            userId,
            contact_id: c.id,
            message: (error as Error).message,
          });
          continue;
        }
      }

      if (!extracted) {
        aiEmpty++;
        continue;
      }

      const fieldsReturned: string[] = [];
      const evidenceBase = `From ${bodies.length} message${bodies.length === 1 ? "" : "s"}`;

      const pushSuggestion = (
        field: SuggestionField,
        value: string,
        keyValue: string,
        confidence: Confidence = "high",
      ) => {
        const key = `${c.id}|${field}|${keyValue.toLowerCase()}`;
        if (existing.has(key)) return false;
        rows.push({
          user_id: userId,
          contact_id: c.id,
          run_id: runId,
          field,
          value,
          source: "email_signature",
          evidence: `${evidenceBase} · signature`,
          confidence,
        });
        existing.add(key);
        fieldsReturned.push(field);
        return true;
      };

      const name = (extracted.name ?? "").trim();
      if (
        name &&
        name.length >= 2 &&
        name.length <= 80 &&
        /\s/.test(name) && // require at least a two-part name to reduce noise
        (!c.name || c.name.trim().toLowerCase() !== name.toLowerCase())
      ) {
        // Only suggest a name change when the current name is missing or clearly
        // differs from what the signature shows.
        if (!c.name || !c.name.trim()) {
          pushSuggestion("name", name.slice(0, 80), name);
        }
      }

      const company = (extracted.company ?? "").trim();
      if (company && !c.company) {
        pushSuggestion("company", company.slice(0, 120), company);
      }

      const title = (extracted.title ?? "").trim();
      if (title && !c.title) {
        pushSuggestion("title", title.slice(0, 120), title);
      }

      const existingPhones = phonesByContact.get(c.id) ?? new Set<string>();
      for (const raw of extracted.phones ?? []) {
        const normalized = normalizePhone(raw);
        if (!normalized || normalized.length < 7) continue;
        if (existingPhones.has(normalized)) continue;
        if (pushSuggestion("phone", normalized, normalized)) {
          existingPhones.add(normalized);
        }
      }

      for (const rawEmail of extracted.emails ?? []) {
        const email = rawEmail.trim().toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
        if (email === addr) continue;
        if (knownEmails.has(email)) continue;
        if (pushSuggestion("email", email, email, "medium")) {
          knownEmails.add(email);
        }
      }

      if (fieldsReturned.length > 0) aiSuccess++;
      else aiEmpty++;

      logInfo("contact_enrichment.contact_extracted", {
        userId,
        contact_id: c.id,
        fields: fieldsReturned,
        message_count: bodies.length,
      });
    }

    // ---------- Domain fallback: only when AI produced no company for that contact ----------
    const suggestedCompanyContacts = new Set(
      rows.filter((r) => r.field === "company").map((r) => r.contact_id),
    );
    for (const c of candidates) {
      if (!c.email || c.company) continue;
      if (suggestedCompanyContacts.has(c.id)) continue;
      if (dismissedDomainCompany.has(c.id)) continue;
      const domain = c.email.split("@")[1]?.toLowerCase();
      if (!domain || PERSONAL_DOMAINS.has(domain)) continue;
      const company = deriveCompanyFromDomain(domain);
      if (!company) continue;
      const key = `${c.id}|company|${company.toLowerCase()}`;
      if (existing.has(key)) continue;
      rows.push({
        user_id: userId,
        contact_id: c.id,
        run_id: runId,
        field: "company",
        value: company,
        source: "domain_derived",
        evidence: `Derived from ${c.email}`,
        confidence: "low",
      });
      existing.add(key);
    }

    // ---------- Name-based email match for contacts WITHOUT an email ----------
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
          if (rank(conf) > rank(prev.confidence)) prev.confidence = conf;
        }
      }

      for (const [addr, info] of byAddr) {
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
      ai_attempts: forAi.length,
      ai_success: aiSuccess,
      ai_empty: aiEmpty,
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

/** List suggestions grouped by contact. Defaults to pending; pass status='dismissed' for the declines tab. */
export const listContactEnrichmentSuggestions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { status?: "pending" | "dismissed" } | undefined) =>
    z
      .object({ status: z.enum(["pending", "dismissed"]).optional() })
      .default({})
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const status = data.status ?? "pending";
    const { data: rows, error } = await supabase
      .from("contact_enrichment_suggestions")
      .select(
        "id, contact_id, field, value, source, evidence, confidence, created_at, contacts!inner(id, name, email, company, title)",
      )
      .eq("status", status)
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
      { contact: ContactMini; suggestions: Array<Omit<Row, "contacts">> }
    >();
    for (const r of (rows as Row[] | null) ?? []) {
      const c = Array.isArray(r.contacts) ? r.contacts[0] : r.contacts;
      if (!c) continue;
      const bucket = grouped.get(r.contact_id) ?? { contact: c, suggestions: [] };
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
      const patch: { email?: string; company?: string; title?: string; name?: string } = {};
      if (sug.field === "email") patch.email = sug.value.toLowerCase();
      if (sug.field === "company") patch.company = sug.value;
      if (sug.field === "title") patch.title = sug.value;
      if (sug.field === "name") patch.name = sug.value;
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

/** Restore a dismissed suggestion back to pending (for accidental dismisses). */
export const undismissContactEnrichmentSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { suggestionId: string }) =>
    z.object({ suggestionId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("contact_enrichment_suggestions")
      .update({ status: "pending" })
      .eq("id", data.suggestionId)
      .eq("status", "dismissed");
    if (error) throw new Error(error.message);
    return { restored: true as const };
  });
