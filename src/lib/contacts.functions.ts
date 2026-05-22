import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { generateText, Output } from "ai";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createLovableAiGatewayProvider } from "./ai-gateway";

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

/** List contacts for the current user. */
export const listContacts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("contacts")
      .select("id,email,name,title,company,phone,avatar_url,source,enriched_at,created_at")
      .order("name", { ascending: true, nullsFirst: false })
      .limit(2000);
    if (error) throw new Error(error.message);
    return { contacts: data ?? [] };
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

/** Build contacts from the user's inbox. Idempotent — upserts unique senders. */
export const backfillContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const PAGE = 1000;
    const CAP = 10000;
    const seen = new Map<string, { name: string | null; email: string }>();

    for (let from = 0; from < CAP; from += PAGE) {
      const { data, error } = await supabase
        .from("emails")
        .select("from_addr,from_name")
        .order("received_at", { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) break;
      const batch = data ?? [];
      for (const r of batch) {
        const addr = (r.from_addr || "").trim().toLowerCase();
        if (!isLikelyHuman(addr)) continue;
        if (!seen.has(addr)) seen.set(addr, { name: r.from_name?.trim() || null, email: addr });
      }
      if (batch.length < PAGE) break;
    }

    if (seen.size === 0) return { added: 0, total: 0 };

    const rows = [...seen.values()].map((s) => ({
      user_id: userId,
      email: s.email,
      name: s.name,
      source: "email" as const,
    }));

    // Chunked upsert to avoid huge payloads.
    let added = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error, count } = await supabaseAdmin
        .from("contacts")
        .upsert(chunk, { onConflict: "user_id,email", ignoreDuplicates: true, count: "exact" })
        .select("id", { count: "exact", head: true });
      if (!error) added += count ?? 0;
    }

    const { count: total } = await supabase
      .from("contacts")
      .select("id", { count: "exact", head: true });

    return { added, total: total ?? 0 };
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

    if (!data.force && contact.enriched_at) {
      const age = Date.now() - new Date(contact.enriched_at).getTime();
      if (age < 30 * 24 * 60 * 60 * 1000) return { contact, skipped: true as const };
    }

    const { data: emails } = await supabase
      .from("emails")
      .select("subject,body_text,snippet")
      .eq("from_addr", contact.email)
      .order("received_at", { ascending: false })
      .limit(5);

    const sample = (emails ?? [])
      .map((e, i) => `--- Email ${i + 1} ---\nSubject: ${e.subject ?? ""}\n${(e.body_text || e.snippet || "").slice(0, 2500)}`)
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
        prompt: `Extract contact details for the sender of the emails below from their signatures.
Sender email: ${contact.email}

For each field, return the value or null if not clearly present. Do NOT guess.
- name: full name
- title: job title
- company: company / organization name
- phone: primary phone number (E.164 if possible)
- website: company or personal website URL
- linkedin: full LinkedIn profile URL
- twitter: full Twitter/X profile URL

Emails:
${sample}`,
      });
      extracted = output as z.infer<typeof EXTRACT_SCHEMA>;
    } catch (e: any) {
      console.error("enrichContact failed", e?.message ?? e);
    }

    const patch: Record<string, any> = { enriched_at: new Date().toISOString() };
    for (const k of ["name", "title", "company", "phone", "website", "linkedin", "twitter"] as const) {
      const v = extracted[k];
      if (v && (!contact[k] || data.force)) patch[k] = v;
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
    const { data: row, error } = await supabaseAdmin
      .from("contacts")
      .upsert(
        { user_id: userId, ...data, email, source: "scan", enriched_at: new Date().toISOString() },
        { onConflict: "user_id,email" }
      )
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { contact: row };
  });
