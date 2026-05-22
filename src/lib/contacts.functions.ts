import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { generateText, Output } from "ai";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createLovableAiGatewayProvider } from "./ai-gateway";
import { sendContactShareEmail } from "./cards.server";

function getModel(modelId = "google/gemini-2.5-flash") {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  return createLovableAiGatewayProvider(key)(modelId);
}

const EXTRACT_SCHEMA = z.object({
  name: z.string().nullable(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  linkedin: z.string().nullable(),
  twitter: z.string().nullable(),
});

const BANNED_DOMAINS = new Set([
  "noreply", "no-reply", "donotreply", "do-not-reply",
  "notifications", "notification", "support", "info", "hello", "help",
  "mailer-daemon", "bounces", "postmaster",
]);

function isLikelyHuman(addr: string | null): boolean {
  if (!addr) return false;
  const lower = addr.toLowerCase().trim();
  const local = lower.split("@")[0] || "";
  for (const b of BANNED_DOMAINS) if (local.includes(b)) return false;
  return /@/.test(lower);
}

/** Normalize a contact display name to "First Last" form. Returns null for garbage. */
export function normalizeName(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim();
  // Strip surrounding quotes / angle brackets
  s = s.replace(/^["'`<\s]+|["'`>\s]+$/g, "");
  // Drop trailing parenthetical noise like "(via Acme)" or "[External]"
  s = s.replace(/\s*[\(\[][^)\]]*[\)\]]\s*$/g, "");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  // Reject if it's actually an email address
  if (/@/.test(s) && /\.[a-z]{2,}$/i.test(s)) return null;

  // "Last, First [Middle]" → "First [Middle] Last" (single comma, no extra commas)
  const commaCount = (s.match(/,/g) ?? []).length;
  if (commaCount === 1) {
    const [last, rest] = s.split(",").map((x) => x.trim());
    if (last && rest && /^[\p{L}'’\-\. ]+$/u.test(last) && /^[\p{L}'’\-\. ]+$/u.test(rest)) {
      s = `${rest} ${last}`.replace(/\s+/g, " ").trim();
    }
  }

  // Title-case if ALL CAPS or all lowercase
  const isAllCaps = s === s.toUpperCase() && /[A-Z]/.test(s);
  const isAllLower = s === s.toLowerCase() && /[a-z]/.test(s);
  if (isAllCaps || isAllLower) {
    s = s
      .toLowerCase()
      .split(" ")
      .map((tok) =>
        tok
          .split("-")
          .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
          .join("-")
      )
      .join(" ");
  }

  return s || null;
}

/** Sort key: first token of normalized name, falling back to email local-part. */
function firstNameKey(name: string | null | undefined, email: string): string {
  const n = normalizeName(name ?? null);
  const tok = n ? n.split(" ")[0] : (email.split("@")[0] || "");
  return tok.toLowerCase();
}
/** Pick the more complete name. Never replace a multi-token name with a prefix of itself. */
function pickBetterName(existing: string | null | undefined, candidate: string | null | undefined): string | null {
  const e = normalizeName(existing ?? null);
  const c = normalizeName(candidate ?? null);
  if (!c) return e ?? null;
  if (!e) return c;
  const eTokens = e.split(" ").filter(Boolean);
  const cTokens = c.split(" ").filter(Boolean);
  const eLower = e.toLowerCase();
  const cLower = c.toLowerCase();
  // Candidate is a prefix/subset of existing (e.g. "John" vs "John Federici") — keep existing.
  if (cTokens.length < eTokens.length && (eLower.startsWith(cLower + " ") || eLower === cLower)) return e;
  // Existing is a prefix of candidate — candidate is more complete.
  if (eTokens.length < cTokens.length && (cLower.startsWith(eLower + " ") || cLower === eLower)) return c;
  // Otherwise prefer the one with more tokens; tie → candidate.
  return cTokens.length >= eTokens.length ? c : e;
}


/** List contacts for the current user. */
export const listContacts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("contacts")
      .select("id,email,name,title,company,phone,avatar_url,source,enriched_at,created_at")
      .limit(2000);
    if (error) throw new Error(error.message);
    const rows = (data ?? []).slice().sort((a, b) => {
      const ka = firstNameKey(a.name, a.email);
      const kb = firstNameKey(b.name, b.email);
      if (!ka && kb) return 1;
      if (ka && !kb) return -1;
      return ka.localeCompare(kb);
    });
    return { contacts: rows };

  });

/** Get a single contact + their last few emails. */
export const getContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: contact, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", data.id)
      .single();
    if (error || !contact) throw new Error("Contact not found");
    const { data: emails } = await supabase
      .from("emails")
      .select("id,subject,snippet,received_at")
      .eq("from_addr", contact.email)
      .order("received_at", { ascending: false })
      .limit(10);
    return { contact, recentEmails: emails ?? [] };
  });


/** AI-enrich a contact from their recent email bodies (signatures). */
export const enrichContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; force?: boolean }) =>
    z.object({ id: z.string().uuid(), force: z.boolean().optional() }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: contact, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", data.id)
      .single();
    if (error || !contact) throw new Error("Contact not found");

    // One-time normalize of existing name so opening a contact cleans it up.
    {
      const normalized = normalizeName(contact.name);
      if (normalized && normalized !== contact.name) {
        await supabase.from("contacts").update({ name: normalized }).eq("id", contact.id);
        (contact as any).name = normalized;
      }
    }

    if (!data.force && contact.enriched_at) {
      const age = Date.now() - new Date(contact.enriched_at).getTime();
      if (age < 30 * 24 * 60 * 60 * 1000) return { contact, skipped: true as const };
    }

    const { data: emails } = await supabase
      .from("emails")
      .select("subject,body_text,snippet,from_name")
      .eq("from_addr", contact.email)
      .order("received_at", { ascending: false })
      .limit(40);

    // Best candidate from the most recent non-empty from_name (handles "Last, First").
    const fromNameCandidate = normalizeName(
      (emails ?? []).map((e) => e.from_name).find((n) => n && n.trim().length > 0) ?? null
    );

    // Strip quoted-reply blocks and take the tail (where signatures live).
    const cleanTail = (raw: string): string => {
      let s = raw || "";
      const cutMarkers = [
        /\n[ \t]*On .{1,120}wrote:\s*\n/i,
        /\n[ \t]*-+\s*Original Message\s*-+/i,
        /\n[ \t]*From:\s.+\nSent:\s/i,
        /\n[ \t]*From:\s.+\nDate:\s/i,
      ];
      for (const re of cutMarkers) {
        const m = s.match(re);
        if (m && m.index !== undefined) s = s.slice(0, m.index);
      }
      s = s.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n");
      return s.slice(-1500);
    };

    const MOBILE_RE = /sent from my (iphone|ipad|android|mobile|blackberry|samsung|phone)|get outlook for (ios|android)/i;
    const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
    const URL_RE = /https?:\/\/[^\s)>\]]+/i;
    const LINKEDIN_RE = /linkedin\.com\/in\//i;
    const SIGNOFF_RE = /\b(best|regards|thanks|cheers|sincerely|kind regards|warmly|cordially|talk soon)[,!.\s]/i;
    const SIG_SEP_RE = /(^|\n)\s*(--|—|–)\s*\n/;

    const scoreEmail = (tail: string): number => {
      let s = 0;
      if (MOBILE_RE.test(tail)) s -= 50;
      if (tail.length > 400) s += 10;
      if (tail.length > 1000) s += 5;
      if (PHONE_RE.test(tail)) s += 15;
      if (LINKEDIN_RE.test(tail)) s += 20;
      if (URL_RE.test(tail)) s += 5;
      if (SIGNOFF_RE.test(tail)) s += 8;
      if (SIG_SEP_RE.test(tail)) s += 12;
      return s;
    };

    type Cand = { subject: string; tail: string; score: number; len: number };
    const candidates: Cand[] = (emails ?? [])
      .map((e) => {
        const tail = cleanTail(e.body_text || e.snippet || "");
        return { subject: e.subject ?? "", tail, score: scoreEmail(tail), len: tail.length };
      })
      .filter((c) => c.tail.trim().length > 0);

    const byScore = [...candidates].sort((a, b) => b.score - a.score).slice(0, 8);
    const byLen = [...candidates].sort((a, b) => b.len - a.len).slice(0, 2);
    const picked: Cand[] = [];
    const seen = new Set<string>();
    for (const c of [...byScore, ...byLen]) {
      const key = c.subject + "::" + c.tail.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(c);
      if (picked.length >= 8) break;
    }

    const sample = picked
      .map((e, i) => `--- Email ${i + 1} ---\nSubject: ${e.subject}\n${e.tail}`)
      .join("\n\n");

    if (!sample.trim()) {
      await supabase.from("contacts").update({ enriched_at: new Date().toISOString() }).eq("id", contact.id);
      return { contact, skipped: false as const };
    }

    let extracted: z.infer<typeof EXTRACT_SCHEMA> = {
      name: null, title: null, company: null, phone: null, website: null, linkedin: null, twitter: null,
    };
    try {
      const { output } = await generateText({
        model: getModel("google/gemini-2.5-flash"),
        output: Output.object({ schema: EXTRACT_SCHEMA }),
        prompt: `You are extracting contact details for a single sender across MULTIPLE emails they sent. Signatures may appear in only some emails (desktop-sent); phone-sent emails often have none. Merge across all emails. If a value appears in multiple emails, prefer it. Return null for any field not clearly present — do NOT guess.

Sender email (fixed, do not change): ${contact.email}

Fields:
- name: full name
- title: job title
- company: company / organization name
- phone: primary phone number (E.164 if possible)
- website: company or personal website URL
- linkedin: full LinkedIn profile URL
- twitter: full Twitter/X profile URL

Emails (most-signature-likely first):
${sample}`,
      });
      extracted = output as z.infer<typeof EXTRACT_SCHEMA>;
    } catch (e: any) {
      console.error("enrichContact failed", e?.message ?? e);
    }

    const patch: {
      enriched_at: string;
      name?: string | null;
      title?: string | null;
      company?: string | null;
      phone?: string | null;
      website?: string | null;
      linkedin?: string | null;
      twitter?: string | null;
      relationship_summary?: string | null;
      summary_generated_at?: string | null;
    } = { enriched_at: new Date().toISOString() };
    for (const k of ["name", "title", "company", "phone", "website", "linkedin", "twitter"] as const) {
      let v = extracted[k];
      if (k === "name") {
        let best = pickBetterName(contact.name, fromNameCandidate);
        best = pickBetterName(best, v);
        if (best && best !== contact.name) patch.name = best;
        continue;
      }
      if (v && (!contact[k] || data.force)) patch[k] = v;
    }

    // === Relationship summary: who are they, what have you discussed? ===
    try {
      const addr = contact.email;
      const { data: convo } = await supabase
        .from("emails")
        .select("subject,body_text,snippet,from_addr,to_addrs,received_at")
        .or(`from_addr.eq.${addr},to_addrs.ilike.%${addr}%`)
        .order("received_at", { ascending: false })
        .limit(30);

      const convoSample = (convo ?? [])
        .map((e, i) => {
          const inbound = (e.from_addr || "").toLowerCase() === addr.toLowerCase();
          const tail = cleanTail(e.body_text || e.snippet || "").slice(-600);
          const when = e.received_at ? new Date(e.received_at).toISOString().slice(0, 10) : "";
          return `--- ${i + 1} [${inbound ? "THEY SENT" : "YOU SENT"}] ${when} ---\nSubject: ${e.subject ?? ""}\n${tail}`;
        })
        .join("\n\n");

      if (convoSample.trim()) {
        const mergedName = patch.name ?? contact.name ?? null;
        const mergedTitle = patch.title ?? contact.title ?? null;
        const mergedCompany = patch.company ?? contact.company ?? null;
        const knownBits = [
          mergedName ? `Name: ${mergedName}` : null,
          mergedTitle ? `Title: ${mergedTitle}` : null,
          mergedCompany ? `Company: ${mergedCompany}` : null,
          `Email: ${addr}`,
        ].filter(Boolean).join("\n");

        const { text: summary } = await generateText({
          model: getModel("google/gemini-2.5-flash"),
          prompt: `Write a concise 3-5 sentence briefing about this contact for the account owner ("you"). Cover:
1) Who they are — name, role, company if known.
2) The nature of your relationship (client, vendor, colleague, recruiter, friend, etc.) — infer from tone and content.
3) The main topics, projects, or recurring threads you've discussed.

Be specific and reference actual topics from the emails. Use plain prose (no bullet points, no headings). If signal is thin, say so briefly. Do not invent facts.

Known details:
${knownBits}

Recent correspondence (newest first; both directions):
${convoSample}`,
        });
        const cleaned = (summary || "").trim();
        if (cleaned) {
          patch.relationship_summary = cleaned;
          patch.summary_generated_at = new Date().toISOString();
        }
      }
    } catch (e: any) {
      console.error("relationship summary failed", e?.message ?? e);
    }

    const { data: updated, error: upErr } = await supabase
      .from("contacts")
      .update(patch)
      .eq("id", contact.id)
      .select("*")
      .single();
    if (upErr) throw new Error(upErr.message);
    return { contact: updated, skipped: false as const };
  });

/** Update a contact (manual edits). */
export const updateContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: any) =>
    z.object({
      id: z.string().uuid(),
      name: z.string().max(200).nullable().optional(),
      title: z.string().max(200).nullable().optional(),
      company: z.string().max(200).nullable().optional(),
      phone: z.string().max(60).nullable().optional(),
      website: z.string().max(500).nullable().optional(),
      linkedin: z.string().max(500).nullable().optional(),
      twitter: z.string().max(500).nullable().optional(),
      notes: z.string().max(5000).nullable().optional(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { id, ...patch } = data;
    if ("name" in patch) patch.name = normalizeName(patch.name ?? null);
    const { data: updated, error } = await supabase
      .from("contacts")
      .update(patch)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { contact: updated };
  });

/** Delete a contact. */
export const deleteContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase.from("contacts").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Scan a photo of a paper business card → extracted draft fields. */
export const scanCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { imageDataUrl: string }) =>
    z.object({
      imageDataUrl: z.string().min(64).max(15_000_000).regex(/^data:image\//, "Must be a data URL"),
    }).parse(d)
  )
  .handler(async ({ data }) => {
    const SCAN_SCHEMA = z.object({
      name: z.string().nullable(),
      title: z.string().nullable(),
      company: z.string().nullable(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      website: z.string().nullable(),
      linkedin: z.string().nullable(),
      twitter: z.string().nullable(),
    });

    try {
      const { output } = await generateText({
        model: getModel("google/gemini-2.5-flash"),
        output: Output.object({ schema: SCAN_SCHEMA }),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extract contact information from this business card photo. Return each field exactly as printed or null if not visible. Do NOT invent values.",
              },
              { type: "image", image: data.imageDataUrl },
            ],
          },
        ],
      });
      return { draft: output as z.infer<typeof SCAN_SCHEMA> };
    } catch (e: any) {
      throw new Error(`Couldn't read the card: ${e?.message ?? "AI vision failed"}`);
    }
  });

/** Create a contact from a scanned-card draft. */
export const createContactFromScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: any) =>
    z.object({
      email: z.string().email(),
      name: z.string().max(200).nullable().optional(),
      title: z.string().max(200).nullable().optional(),
      company: z.string().max(200).nullable().optional(),
      phone: z.string().max(60).nullable().optional(),
      website: z.string().max(500).nullable().optional(),
      linkedin: z.string().max(500).nullable().optional(),
      twitter: z.string().max(500).nullable().optional(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const email = data.email.trim().toLowerCase();
    const payload = { ...data, name: normalizeName(data.name ?? null) };
    const { data: row, error } = await supabaseAdmin
      .from("contacts")
      .upsert(
        { user_id: userId, ...payload, email, source: "scan", enriched_at: new Date().toISOString() },
        { onConflict: "user_id,email" }
      )
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { contact: row };
  });

/** Add a contact from a specific email and extract details from its signature. */
export const addContactFromEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { emailId: string }) =>
    z.object({ emailId: z.string().uuid() }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: email, error: emailErr } = await supabase
      .from("emails")
      .select("from_addr,from_name,subject,body_text,snippet")
      .eq("id", data.emailId)
      .single();
    if (emailErr || !email) throw new Error("Email not found");

    const addr = (email.from_addr || "").trim().toLowerCase();
    if (!addr || !/@/.test(addr)) throw new Error("This email has no sender address");

    // Upsert the base contact
    const { data: base, error: upErr } = await supabaseAdmin
      .from("contacts")
      .upsert(
        {
          user_id: userId,
          email: addr,
          name: normalizeName(email.from_name) ?? null,
          source: "email" as const,
        },
        { onConflict: "user_id,email" }
      )
      .select("*")
      .single();
    if (upErr || !base) throw new Error(upErr?.message ?? "Could not save contact");

    // Extract from this specific email's body
    const body = (email.body_text || email.snippet || "").slice(0, 6000);
    let extracted: z.infer<typeof EXTRACT_SCHEMA> = {
      name: null, title: null, company: null, phone: null, website: null, linkedin: null, twitter: null,
    };
    if (body.trim()) {
      try {
        const { output } = await generateText({
          model: getModel("google/gemini-2.5-flash"),
          output: Output.object({ schema: EXTRACT_SCHEMA }),
          prompt: `Extract contact details for the sender from their email signature below.
Sender email: ${addr}

For each field, return the value or null if not clearly present. Do NOT guess.
- name: full name
- title: job title
- company: company / organization name
- phone: primary phone number (E.164 if possible)
- website: company or personal website URL
- linkedin: full LinkedIn profile URL
- twitter: full Twitter/X profile URL

Email:
Subject: ${email.subject ?? ""}
${body}`,
        });
        extracted = output as z.infer<typeof EXTRACT_SCHEMA>;
      } catch (e: any) {
        console.error("addContactFromEmail extract failed", e?.message ?? e);
      }
    }

    const patch: {
      enriched_at: string;
      name?: string | null; title?: string | null; company?: string | null;
      phone?: string | null; website?: string | null; linkedin?: string | null; twitter?: string | null;
    } = { enriched_at: new Date().toISOString() };
    for (const k of ["name", "title", "company", "phone", "website", "linkedin", "twitter"] as const) {
      let v = extracted[k];
      if (k === "name") {
        const better = pickBetterName((base as any).name, v);
        if (better && better !== (base as any).name) patch.name = better;
        continue;
      }
      if (v && !(base as any)[k]) patch[k] = v;
    }

    const { data: updated, error: updErr } = await supabase
      .from("contacts")
      .update(patch)
      .eq("id", base.id)
      .select("*")
      .single();
    if (updErr) throw new Error(updErr.message);

    return { contact: updated };
  });

/** Share a saved contact's info with someone via the user's connected Gmail. */
export const shareContactByEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: any) =>
    z.object({
      contactId: z.string().uuid(),
      toEmail: z.string().email(),
      note: z.string().max(2000).optional(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context;

    const { data: contact, error } = await supabase
      .from("contacts")
      .select("name,title,company,email,phone,website,linkedin,twitter")
      .eq("id", data.contactId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!contact) throw new Error("Contact not found");

    const { data: account } = await supabaseAdmin
      .from("gmail_accounts")
      .select("id, email_address")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!account) throw new Error("Connect your Gmail account in Settings first.");

    await sendContactShareEmail({
      accountId: account.id,
      fromEmail: account.email_address,
      toEmail: data.toEmail,
      contact,
      note: data.note ?? null,
    });

    return { ok: true };
  });


/** Manually create a contact. */
export const createContactManual = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: any) =>
    z.object({
      email: z.string().trim().toLowerCase().email().max(255),
      name: z.string().trim().max(200).optional().nullable(),
      title: z.string().trim().max(200).optional().nullable(),
      company: z.string().trim().max(200).optional().nullable(),
      phone: z.string().trim().max(60).optional().nullable(),
      website: z.string().trim().max(500).optional().nullable(),
      linkedin: z.string().trim().max(500).optional().nullable(),
      twitter: z.string().trim().max(500).optional().nullable(),
      notes: z.string().trim().max(5000).optional().nullable(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const payload = {
      user_id: userId,
      email: data.email,
      name: normalizeName(data.name ?? null),
      title: data.title || null,
      company: data.company || null,
      phone: data.phone || null,
      website: data.website || null,
      linkedin: data.linkedin || null,
      twitter: data.twitter || null,
      notes: data.notes || null,
      source: "manual",
    };
    const { data: row, error } = await supabaseAdmin
      .from("contacts")
      .upsert(payload, { onConflict: "user_id,email" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { contact: row };
  });

/** Lightweight folder list for the sender picker. */
export const listFoldersForPicker = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("folders")
      .select("id,name,color")
      .order("priority", { ascending: false })
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);
    return { folders: data ?? [] };
  });

/** List unique sender addresses from the user's emails, optionally scoped to folders, excluding existing contacts. */
export const listUniqueInboxSenders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: any) =>
    z.object({
      folderIds: z.array(z.string().uuid()).max(50).optional(),
      search: z.string().trim().max(200).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }).parse(d ?? {})
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Pull a chunk of recent emails (cap at 5k to keep aggregation fast).
    let q = supabase
      .from("emails")
      .select("from_addr,from_name,received_at,folder_id")
      .eq("user_id", userId)
      .not("from_addr", "is", null)
      .order("received_at", { ascending: false })
      .limit(5000);
    if (data.folderIds && data.folderIds.length > 0) {
      q = q.in("folder_id", data.folderIds);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    // Existing contact addresses (to exclude).
    const { data: existing } = await supabaseAdmin
      .from("contacts")
      .select("email")
      .eq("user_id", userId);
    const existingSet = new Set((existing ?? []).map((c: any) => (c.email || "").toLowerCase()));

    type Agg = { email: string; name: string | null; count: number; lastReceivedAt: string | null };
    const agg = new Map<string, Agg>();
    for (const r of rows ?? []) {
      const addr = (r.from_addr || "").trim().toLowerCase();
      if (!addr || !isLikelyHuman(addr)) continue;
      if (existingSet.has(addr)) continue;
      const cur = agg.get(addr);
      const nm = normalizeName(r.from_name);
      if (!cur) {
        agg.set(addr, { email: addr, name: nm, count: 1, lastReceivedAt: r.received_at ?? null });
      } else {
        cur.count++;
        if (nm && (!cur.name || nm.length > cur.name.length)) cur.name = nm;
        if (r.received_at && (!cur.lastReceivedAt || r.received_at > cur.lastReceivedAt)) {
          cur.lastReceivedAt = r.received_at;
        }
      }
    }

    let list = [...agg.values()];
    const search = (data.search || "").toLowerCase().trim();
    if (search) {
      list = list.filter(
        (x) => x.email.includes(search) || (x.name ?? "").toLowerCase().includes(search)
      );
    }
    list.sort((a, b) => b.count - a.count);
    const limit = data.limit ?? 200;
    return { senders: list.slice(0, limit) };
  });

/** Bulk-create contacts from a list of {email, name?}. */
export const bulkCreateContactsFromEmails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: any) =>
    z.object({
      items: z.array(
        z.object({
          email: z.string().trim().toLowerCase().email().max(255),
          name: z.string().trim().max(200).optional().nullable(),
        })
      ).min(1).max(200),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const rows = data.items.map((it) => ({
      user_id: userId,
      email: it.email,
      name: normalizeName(it.name ?? null),
      source: "email",
    }));
    const { error, count } = await supabaseAdmin
      .from("contacts")
      .upsert(rows, { onConflict: "user_id,email", count: "exact" });
    if (error) throw new Error(error.message);
    return { created: count ?? rows.length };
  });
