import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { generateText, Output } from "ai";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendContactShareEmail } from "../cards.server";
import { setContactEncryptedFields } from "../sync/encrypted-writer";
import {
  getContactDecrypted,
  getContactListFieldsDecrypted,
  getEmailsDecrypted,
} from "../sync/encrypted-reader";
import {
  fetchFromGmail,
  getModel,
  EXTRACT_SCHEMA,
  ADDRESS_FIELDS,
  isLikelyHuman,
  normalizeName,
  firstNameKey,
  pickBetterName,
  phoneEntrySchema,
} from "../contacts-helpers.server";

export const enrichContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; force?: boolean }) =>
    z.object({ id: z.string().uuid(), force: z.boolean().optional() }).parse(d),
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
        contact.name = normalized;
      }
    }

    if (!contact.email) {
      // No email → nothing to enrich from mail history. Return as-is.
      return { contact, skipped: true as const };
    }

    if (!data.force && contact.enriched_at) {
      const age = Date.now() - new Date(contact.enriched_at).getTime();
      if (age < 30 * 24 * 60 * 60 * 1000) return { contact, skipped: true as const };
    }

    // 2-step: filter on plaintext from_addr to get ids, then decrypt
    // bodies via get_emails_decrypted. Keeps Postgres-side filter cheap
    // and works after the plaintext body columns are dropped.
    const { data: idRows } = await supabase
      .from("emails")
      .select("id")
      .eq("from_addr", contact.email)
      .order("received_at", { ascending: false })
      .limit(40);
    const { rows: decrypted } = await getEmailsDecrypted((idRows ?? []).map((r) => r.id));
    const localEmails = decrypted.map((r) => ({
      subject: r.subject,
      body_text: r.body_text,
      snippet: r.snippet,
      from_name: r.from_name,
    }));

    // Lazy-load the user's Gmail accounts — used as a fallback below when
    // local storage has nothing for this address yet (new contacts, or
    // mail that's older than our sync window).
    let gmailAccountIds: string[] | null = null;
    const getGmailAccountIds = async (): Promise<string[]> => {
      if (gmailAccountIds !== null) return gmailAccountIds;
      const { data: accs } = await supabase
        .from("gmail_accounts")
        .select("id")
        .order("created_at", { ascending: true });
      gmailAccountIds = (accs ?? []).map((a) => a.id);
      return gmailAccountIds;
    };

    let emails: Array<{
      subject: string | null;
      body_text: string | null;
      snippet: string | null;
      from_name: string | null;
    }> = localEmails ?? [];

    if (emails.length === 0) {
      const accountIds = await getGmailAccountIds();
      if (accountIds.length > 0) {
        const fetched = await fetchFromGmail(accountIds, `from:${contact.email}`, 20);
        emails = fetched.map((m) => ({
          subject: m.subject ?? null,
          body_text: m.body_text ?? null,
          snippet: m.snippet ?? null,
          from_name: m.from_name ?? null,
        }));
      }
    }

    // Best candidate from the most recent non-empty from_name (handles "Last, First").
    const fromNameCandidate = normalizeName(
      (emails ?? []).map((e) => e.from_name).find((n) => n && n.trim().length > 0) ?? null,
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
      s = s
        .split("\n")
        .filter((l) => !/^\s*>/.test(l))
        .join("\n");
      return s.slice(-1500);
    };

    const MOBILE_RE =
      /sent from my (iphone|ipad|android|mobile|blackberry|samsung|phone)|get outlook for (ios|android)/i;
    const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
    const URL_RE = /https?:\/\/[^\s)>\]]+/i;
    const LINKEDIN_RE = /linkedin\.com\/in\//i;
    const SIGNOFF_RE =
      /\b(best|regards|thanks|cheers|sincerely|kind regards|warmly|cordially|talk soon)[,!.\s]/i;
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
      const betterName = pickBetterName(contact.name, fromNameCandidate);
      const earlyPatch: { enriched_at: string; name?: string } = {
        enriched_at: new Date().toISOString(),
      };
      if (betterName && betterName !== contact.name) earlyPatch.name = betterName;
      const { data: updated } = await supabase
        .from("contacts")
        .update(earlyPatch)
        .eq("id", contact.id)
        .select("*")
        .single();
      return { contact: updated ?? contact, skipped: false as const };
    }

    let extracted: z.infer<typeof EXTRACT_SCHEMA> = {
      name: null,
      title: null,
      company: null,
      phone: null,
      website: null,
      linkedin: null,
      twitter: null,
      address_line1: null,
      address_line2: null,
      city: null,
      region: null,
      postal_code: null,
      country: null,
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
- address_line1: street address, first line (only if a postal address is clearly printed in a signature)
- address_line2: apt / suite / floor (only if present)
- city: city / locality
- region: state / province / region
- postal_code: ZIP / postal code
- country: country

Emails (most-signature-likely first):
${sample}`,
      });
      extracted = output as z.infer<typeof EXTRACT_SCHEMA>;
    } catch (e: unknown) {
      console.error("enrichContact failed", e instanceof Error ? e.message : e);
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
      address_line1?: string | null;
      address_line2?: string | null;
      city?: string | null;
      region?: string | null;
      postal_code?: string | null;
      country?: string | null;
    } = { enriched_at: new Date().toISOString() };
    for (const k of [
      "name",
      "title",
      "company",
      "phone",
      "website",
      "linkedin",
      "twitter",
      ...ADDRESS_FIELDS,
    ] as const) {
      const v = extracted[k];
      if (k === "name") {
        let best = pickBetterName(contact.name, fromNameCandidate);
        best = pickBetterName(best, v);
        if (best && best !== contact.name) patch.name = best;
        continue;
      }
      if (v && (!(contact as Record<string, unknown>)[k] || data.force)) patch[k] = v;
    }
    // Fields persisted only via the encrypted RPC — strip from the
    // plaintext patch since the columns are gone post-Migration B.
    const ENCRYPTED_ONLY = ["phone", "address_line1", "address_line2"] as const;

    // === Relationship summary: who are they, what have you discussed? ===
    try {
      const addr = contact.email;
      const { data: idRows } = await supabase
        .from("emails")
        .select("id")
        .or(`from_addr.eq.${addr},to_addrs.ilike.%${addr}%`)
        .order("received_at", { ascending: false })
        .limit(30);
      const { rows: decryptedConvo } = await getEmailsDecrypted((idRows ?? []).map((r) => r.id));
      let convo: Array<{
        subject: string | null;
        body_text: string | null;
        snippet: string | null;
        from_addr: string | null;
        to_addrs: string | null;
        received_at: string | null;
      }> = decryptedConvo.map((r) => ({
        subject: r.subject,
        body_text: r.body_text,
        snippet: r.snippet,
        from_addr: r.from_addr,
        to_addrs: r.to_addrs,
        received_at: r.received_at,
      }));

      if (convo.length === 0) {
        const accountIds = await getGmailAccountIds();
        if (accountIds.length > 0) {
          const fetched = await fetchFromGmail(accountIds, `from:${addr} OR to:${addr}`, 20);
          convo = fetched.map((m) => ({
            subject: m.subject ?? null,
            body_text: m.body_text ?? null,
            snippet: m.snippet ?? null,
            from_addr: m.from_addr ?? null,
            to_addrs: m.to_addrs ?? null,
            received_at: m.received_at ?? null,
          }));
        }
      }

      const convoSample = convo
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
        ]
          .filter(Boolean)
          .join("\n");

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
    } catch (e: unknown) {
      console.error("relationship summary failed", e instanceof Error ? e.message : e);
    }

    // Persist sensitive fields ONLY via the encrypted RPC. Remove them
    // from the plaintext patch — the columns no longer exist.
    const encryptedPatch = {
      phone: patch.phone,
      relationship_summary: patch.relationship_summary,
      address_line1: patch.address_line1,
      address_line2: patch.address_line2,
    };
    for (const k of [...ENCRYPTED_ONLY, "relationship_summary"] as const) {
      delete (patch as Record<string, unknown>)[k];
    }
    const { data: updated, error: upErr } = await supabase
      .from("contacts")
      .update(patch as never)
      .eq("id", contact.id)
      .select("*")
      .single();
    if (upErr) throw new Error(upErr.message);
    await setContactEncryptedFields({
      contact_id: contact.id,
      phone: encryptedPatch.phone ?? undefined,
      relationship_summary: encryptedPatch.relationship_summary ?? undefined,
      address_line1: encryptedPatch.address_line1 ?? undefined,
      address_line2: encryptedPatch.address_line2 ?? undefined,
    });
    // Re-hydrate decrypted fields onto the returned row so the caller
    // (the inbox / contact drawer) sees the freshly-written values.
    const { row: decRow } = await getContactDecrypted(contact.id);
    return { contact: decRow ?? updated, skipped: false as const };
  });
export const addContactFromEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { emailId: string }) => z.object({ emailId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { rows: emailRows, error: emailErr } = await getEmailsDecrypted([data.emailId]);
    const email = emailRows[0];
    if (emailErr || !email) throw new Error("Email not found");
    if (email.user_id !== userId) throw new Error("Not authorized");

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
        { onConflict: "user_id,email" },
      )
      .select("*")
      .single();
    if (upErr || !base) throw new Error(upErr?.message ?? "Could not save contact");

    // Extract from this specific email's body
    const body = (email.body_text || email.snippet || "").slice(0, 6000);
    let extracted: z.infer<typeof EXTRACT_SCHEMA> = {
      name: null,
      title: null,
      company: null,
      phone: null,
      website: null,
      linkedin: null,
      twitter: null,
      address_line1: null,
      address_line2: null,
      city: null,
      region: null,
      postal_code: null,
      country: null,
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
- address_line1: street address, first line (only if a postal address is clearly printed)
- address_line2: apt / suite / floor (only if present)
- city: city / locality
- region: state / province / region
- postal_code: ZIP / postal code
- country: country

Email:
Subject: ${email.subject ?? ""}
${body}`,
        });
        extracted = output as z.infer<typeof EXTRACT_SCHEMA>;
      } catch (e: unknown) {
        console.error("addContactFromEmail extract failed", e instanceof Error ? e.message : e);
      }
    }

    // After Phase 3, phone/address_line1/address_line2 live only in encrypted
    // columns. Split extracted fields into plaintext patch + encrypted-only.
    const ENCRYPTED_ONLY = ["phone", "address_line1", "address_line2"] as const;
    type EncKey = (typeof ENCRYPTED_ONLY)[number];
    const patch: {
      enriched_at: string;
      name?: string | null;
      title?: string | null;
      company?: string | null;
      website?: string | null;
      linkedin?: string | null;
      twitter?: string | null;
      city?: string | null;
      region?: string | null;
      postal_code?: string | null;
      country?: string | null;
    } = { enriched_at: new Date().toISOString() };
    const encPatch: Partial<Record<EncKey, string | null>> = {};
    const plaintextFields = [
      "name",
      "title",
      "company",
      "website",
      "linkedin",
      "twitter",
      "city",
      "region",
      "postal_code",
      "country",
    ] as const;
    for (const k of plaintextFields) {
      const v = extracted[k];
      if (k === "name") {
        const better = pickBetterName(base.name, v);
        if (better && better !== base.name) patch.name = better;
        continue;
      }
      if (v && !base[k]) patch[k] = v;
    }
    for (const k of ENCRYPTED_ONLY) {
      const v = extracted[k];
      if (v) encPatch[k] = v;
    }

    const { error: updErr } = await supabase.from("contacts").update(patch).eq("id", base.id);
    if (updErr) throw new Error(updErr.message);
    await setContactEncryptedFields({
      contact_id: base.id,
      phone: encPatch.phone ?? undefined,
      address_line1: encPatch.address_line1 ?? undefined,
      address_line2: encPatch.address_line2 ?? undefined,
    });
    const { row: updated } = await getContactDecrypted(base.id);
    return { contact: updated };
  });
