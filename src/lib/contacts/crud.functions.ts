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
  emailEntrySchema,
} from "../contacts-helpers.server";

import { reconcileAutoParentsForContacts } from "./auto-company-subgroups.functions";

export const listContacts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("contacts")
      .select("id,email,name,title,company,website,avatar_url,source,enriched_at,created_at")
      .limit(2000);
    if (error) throw new Error(error.message);
    const rows = (data ?? []).slice().sort((a, b) => {
      const ka = firstNameKey(a.name, a.email ?? "");
      const kb = firstNameKey(b.name, b.email ?? "");
      if (!ka && kb) return 1;
      if (ka && !kb) return -1;
      return ka.localeCompare(kb);
    });
    // Batch decrypt the small per-row fields the list view renders
    // (relationship_summary preview, phone in the company bucket).
    const { rows: decRows } = await getContactListFieldsDecrypted(rows.map((r) => r.id));
    const decMap = new Map(decRows.map((r) => [r.id, r] as const));
    const contacts = rows.map((r) => {
      const d = decMap.get(r.id);
      return {
        ...r,
        phone: d?.phone ?? null,
        relationship_summary: d?.relationship_summary ?? null,
      };
    });
    return { contacts };
  });

/** Get a single contact + their last few emails + phones. */
export const getContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Decrypt via SECURITY DEFINER RPC; returns the full contact row including
    // all encrypted PII fields. Verify ownership before returning.
    const { row, error } = await getContactDecrypted(data.id);
    if (error || !row) throw new Error("Contact not found");
    if (row.user_id !== userId) throw new Error("Forbidden");
    const contact = row;
    const emailsQuery = contact.email
      ? supabase
          .from("emails")
          .select("id,received_at")
          .eq("from_addr", contact.email)
          .order("received_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: [] });
    const [{ data: emails }, { data: phones }, { data: emailRows }] = await Promise.all([
      emailsQuery,
      supabase
        .from("contact_phones")
        .select("id,label,number,is_primary,position")
        .eq("contact_id", data.id)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("contact_emails")
        .select("id,label,address,is_primary,position")
        .eq("contact_id", data.id)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
    ]);
    return {
      contact,
      recentEmails: emails ?? [],
      phones: phones ?? [],
      emails: emailRows ?? [],
    };

  });
export const updateContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        name: z.string().max(200).nullable().optional(),
        title: z.string().max(200).nullable().optional(),
        company: z.string().max(200).nullable().optional(),
        email: z
          .union([z.string(), z.null()])
          .optional()
          .transform((v) => {
            if (v === undefined) return undefined;
            if (v === null) return null;
            const trimmed = v.trim().toLowerCase();
            return trimmed === "" ? null : trimmed;
          })
          .refine(
            (v) => v === undefined || v === null || /.+@.+\..+/.test(v),
            { message: "Enter a valid email address" },
          )
          .refine((v) => v === undefined || v === null || v.length <= 255, {
            message: "Email is too long",
          }),
        phone: z.string().max(60).nullable().optional(),
        website: z.string().max(500).nullable().optional(),
        linkedin: z.string().max(500).nullable().optional(),
        twitter: z.string().max(500).nullable().optional(),
        notes: z.string().max(5000).nullable().optional(),
        address_line1: z.string().trim().max(200).nullable().optional(),
        address_line2: z.string().trim().max(200).nullable().optional(),
        city: z.string().trim().max(120).nullable().optional(),
        region: z.string().trim().max(120).nullable().optional(),
        postal_code: z.string().trim().max(40).nullable().optional(),
        country: z.string().trim().max(60).nullable().optional(),
        card_image_url: z
          .string()
          .max(500)
          .regex(/^[A-Za-z0-9_\-/.]+$/)
          .nullable()
          .optional(),
        phones: z.array(phoneEntrySchema).max(20).optional(),
        emails: z.array(emailEntrySchema).max(20).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { id, phones, emails, ...patch } = data;
    if ("name" in patch) patch.name = normalizeName(patch.name ?? null);

    // If phones provided, sync the primary into the legacy contacts.phone mirror.
    if (phones) {
      const primary = phones.find((p) => p.is_primary) ?? phones[0];
      patch.phone = primary?.number?.trim() || null;
    }

    // If emails provided, sync the primary into the legacy contacts.email
    // column so existing lookups and unique constraints stay consistent.
    if (emails) {
      const primary = emails.find((e) => e.is_primary) ?? emails[0];
      patch.email = primary?.address?.trim().toLowerCase() || null;
    }



    // Split: sensitive fields go through the encrypted RPC only; their
    // plaintext columns no longer exist (Phase 3 Migration B).
    const encryptedPatch = {
      phone: patch.phone,
      notes: patch.notes,
      address_line1: patch.address_line1,
      address_line2: patch.address_line2,
    };
    for (const k of ["phone", "notes", "address_line1", "address_line2"] as const) {
      delete (patch as Record<string, unknown>)[k];
    }

    const { data: updated, error } = await supabase
      .from("contacts")
      .update(patch as never)
      .eq("id", id)
      .select("*")
      .single();
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505") {
        throw new Error("Another contact already uses this email address.");
      }
      throw new Error(error.message);
    }
    await setContactEncryptedFields({
      contact_id: id,
      phone: encryptedPatch.phone ?? undefined,
      notes: encryptedPatch.notes ?? undefined,
      address_line1: encryptedPatch.address_line1 ?? undefined,
      address_line2: encryptedPatch.address_line2 ?? undefined,
    });

    if (phones) {
      // Replace-all strategy. RLS scopes deletes/inserts to the user.
      const { error: delErr } = await supabase.from("contact_phones").delete().eq("contact_id", id);
      if (delErr) throw new Error(delErr.message);
      if (phones.length > 0) {
        const hasPrimary = phones.some((p) => p.is_primary);
        const normalized = phones.map((p, idx) => ({
          user_id: userId,
          contact_id: id,
          label: p.label.trim().toLowerCase(),
          number: p.number.trim(),
          is_primary: hasPrimary ? !!p.is_primary : idx === 0,
          position: idx,
        }));
        const { error: insErr } = await supabase.from("contact_phones").insert(normalized);
        if (insErr) throw new Error(insErr.message);
      }
    }

    if (emails) {
      const { error: delErr } = await supabase.from("contact_emails").delete().eq("contact_id", id);
      if (delErr) throw new Error(delErr.message);
      if (emails.length > 0) {
        const hasPrimary = emails.some((e) => e.is_primary);
        const normalized = emails.map((e, idx) => ({
          user_id: userId,
          contact_id: id,
          label: e.label.trim().toLowerCase(),
          address: e.address.trim().toLowerCase(),
          is_primary: hasPrimary ? !!e.is_primary : idx === 0,
          position: idx,
        }));
        const { error: insErr } = await supabase.from("contact_emails").insert(normalized);
        if (insErr) throw new Error(insErr.message);
      }
    }

    const { data: refreshedPhones } = await supabase
      .from("contact_phones")
      .select("id,label,number,is_primary,position")
      .eq("contact_id", id)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });

    const { data: refreshedEmails } = await supabase
      .from("contact_emails")
      .select("id,label,address,is_primary,position")
      .eq("contact_id", id)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });


    // If company changed, reconcile any auto-company-subgroup parents this
    // contact belongs to so subgroups collapse/rename/split immediately.
    if ("company" in data) {
      await reconcileAutoParentsForContacts(supabase, userId, [id]);
    }

    // Return the decrypted view so the UI re-renders with the new
    // phone/notes/address values written through the encrypted RPC.
    const { row: decRow } = await getContactDecrypted(id);
    return { contact: decRow ?? updated, phones: refreshedPhones ?? [] };
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

/** Rename the `company` field on a set of contacts (used by the company bucket editor). */
export const renameCompanyForContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        contactIds: z.array(z.string().uuid()).min(1).max(1000),
        newName: z.string().trim().min(1).max(200),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error, count } = await supabase
      .from("contacts")
      .update({ company: data.newName }, { count: "exact" })
      .eq("user_id", userId)
      .in("id", data.contactIds);
    if (error) throw new Error(error.message);
    await reconcileAutoParentsForContacts(supabase, userId, data.contactIds);
    return { updated: count ?? 0 };
  });

/**
 * Set (or clear) the `website` field on every contact in a bucket. Used by
 * the company dialog for name-only buckets so the user can attach a primary
 * domain — bucketing then upgrades the bucket to a domain-keyed one on the
 * next refresh via `contactLogoDomain(website, email)`.
 */
export const setCompanyWebsiteForContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        contactIds: z.array(z.string().uuid()).min(1).max(1000),
        website: z.string().trim().max(500).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const value = data.website && data.website.length > 0 ? data.website : null;
    const { error, count } = await supabase
      .from("contacts")
      .update({ website: value }, { count: "exact" })
      .eq("user_id", userId)
      .in("id", data.contactIds);
    if (error) throw new Error(error.message);
    return { updated: count ?? 0 };
  });

/** Manually create a contact. */
export const createContactManual = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        email: z.string().trim().toLowerCase().email().max(255),
        name: z.string().trim().max(200).optional().nullable(),
        title: z.string().trim().max(200).optional().nullable(),
        company: z.string().trim().max(200).optional().nullable(),
        phone: z.string().trim().max(60).optional().nullable(),
        website: z.string().trim().max(500).optional().nullable(),
        linkedin: z.string().trim().max(500).optional().nullable(),
        twitter: z.string().trim().max(500).optional().nullable(),
        notes: z.string().trim().max(5000).optional().nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    // phone / notes live in encrypted columns only after Phase 3.
    const payload = {
      user_id: userId,
      email: data.email,
      name: normalizeName(data.name ?? null),
      title: data.title || null,
      company: data.company || null,
      website: data.website || null,
      linkedin: data.linkedin || null,
      twitter: data.twitter || null,
      source: "manual",
    };
    const { data: row, error } = await supabaseAdmin
      .from("contacts")
      .upsert(payload, { onConflict: "user_id,email" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    if (row && (data.phone || data.notes)) {
      await setContactEncryptedFields({
        contact_id: row.id,
        phone: data.phone ?? undefined,
        notes: data.notes ?? undefined,
      });
    }
    if (row?.id && row.company) {
      const { supabase } = context;
      await reconcileAutoParentsForContacts(supabase, userId, [row.id]);
    }
    return { contact: row };
  });

/** Bulk-create contacts from a list of {email, name?}. */
export const bulkCreateContactsFromEmails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        items: z
          .array(
            z.object({
              email: z.string().trim().toLowerCase().email().max(255),
              name: z.string().trim().max(200).optional().nullable(),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(d),
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
