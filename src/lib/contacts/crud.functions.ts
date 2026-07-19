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
import { resolveContactCompany } from "@/lib/companies/companies.functions";
import { applyRulesForContact } from "./group-rules.functions";

/**
 * Fields we treat as "user-owned once you edit them". Enrichment reads this
 * list from `contacts.manual_overrides` and skips any field named here that
 * the user has set by hand, even on a forced rerun. Keep in one place so
 * `crud` and `enrich` can't drift.
 */
export const MANUAL_TRACKED_FIELDS = [
  "name",
  "title",
  "company",
  "phone",
  "website",
  "linkedin",
  "twitter",
  "notes",
  "address_line1",
  "address_line2",
  "city",
  "region",
  "postal_code",
  "country",
] as const;
export type ManualTrackedField = (typeof MANUAL_TRACKED_FIELDS)[number];

const MANUAL_TRACKED_SET: Set<string> = new Set(MANUAL_TRACKED_FIELDS);

/**
 * Merge `patch` into `current` overrides:
 *   - a non-empty tracked field is added (user set it)
 *   - an explicit null / empty-string tracked field is removed (user cleared
 *     it, so enrichment may fill it again).
 * Fields not present in the patch are left alone.
 */
export function computeManualOverrides(
  current: readonly string[] | null | undefined,
  patch: Record<string, unknown>,
): string[] {
  const set = new Set<string>(current ?? []);
  for (const [key, value] of Object.entries(patch)) {
    if (!MANUAL_TRACKED_SET.has(key)) continue;
    const isCleared = value === null || (typeof value === "string" && value.trim() === "");
    if (isCleared) set.delete(key);
    else if (value !== undefined) set.add(key);
  }
  return Array.from(set).sort();
}

export const listContacts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("contacts")
      .select(
        "id,email,name,title,company,company_id,website,avatar_url,source,enriched_at,created_at",
      )
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
    // company_id isn't returned by the decrypt RPC; fetch it separately so
    // we can resolve the company's primary domain for the logo fallback.
    const { data: companyLink } = await supabase
      .from("contacts")
      .select("company_id,company_logo_photo_sha,avatar_source")
      .eq("id", data.id)
      .maybeSingle();
    const linkedCompanyId = companyLink?.company_id ?? null;
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
    const { resolveCompanyLogoDomainForContact } = await import("@/lib/contacts/logo-photo.server");
    const companyDomain = await resolveCompanyLogoDomainForContact(userId, {
      id: data.id,
      company_id: linkedCompanyId,
      website: contact.website,
      email: contact.email,
    });
    let avatarIsCompanyLogoSnapshot = false;
    let effectiveAvatarUrl: string | null = contact.avatar_url ?? null;
    const avatarSource =
      (companyLink as { avatar_source?: string | null } | null)?.avatar_source ?? "unknown";
    // Never self-heal photos the user explicitly chose. "user_upload" is the
    // web/app uploader; "carddav" is a legacy label for iPhone Contacts saves
    // (current writes use "user_upload" — see handlers.server.ts). Either way
    // a human picked the picture, so leave it alone.
    const isUserChosenPhoto = avatarSource === "user_upload" || avatarSource === "carddav";
    if (contact.avatar_url && linkedCompanyId && !isUserChosenPhoto) {
      try {
        const { loadContactPhotoBytes, sha256Hex, deleteContactPhoto } =
          await import("@/lib/contacts/photos.server");
        const own = await loadContactPhotoBytes(contact.avatar_url);
        if (own) {
          const ownSha = await sha256Hex(own.bytes);
          const storedLogoSha = companyLink?.company_logo_photo_sha ?? null;
          let matchedSha: string | null =
            storedLogoSha !== null && storedLogoSha === ownSha ? storedLogoSha : null;

          if (matchedSha === null) {
            const { getKnownCompanyLogoHashes } = await import("@/lib/contacts/logo-photo.server");
            matchedSha = (await getKnownCompanyLogoHashes(userId, linkedCompanyId)).has(ownSha)
              ? ownSha
              : null;
          }

          if (matchedSha === null && companyDomain) {
            // Fast path: currently chosen logo for this contact's domain.
            const { fetchChosenCompanyLogoBytes } =
              await import("@/lib/contacts/logo-photo.server");
            const hit = await fetchChosenCompanyLogoBytes(userId, companyDomain);
            if (hit) {
              const logoSha = await sha256Hex(hit.bytes);
              if (logoSha === ownSha) {
                matchedSha = logoSha;
                const { recordCompanyLogoHash } = await import("@/lib/contacts/logo-photo.server");
                await recordCompanyLogoHash({
                  userId,
                  companyId: linkedCompanyId,
                  domain: companyDomain,
                  sha256: logoSha,
                  source: "detail_view",
                });
              }
            }
          }

          if (matchedSha === null) {
            // Broader fallback: check every provider variant for every domain
            // linked to this contact's company. Catches stale snapshots from
            // an older logo pick or a different provider that no longer
            // returns the same bytes today.
            const { findMatchingCompanyLogoSha } = await import("@/lib/contacts/logo-photo.server");
            matchedSha = await findMatchingCompanyLogoSha(
              userId,
              linkedCompanyId,
              ownSha,
              sha256Hex,
            );
          }

          if (matchedSha !== null) {
            avatarIsCompanyLogoSnapshot = true;
            // Self-heal: remove the frozen snapshot so it can never race the
            // company-logo render again, and fingerprint the contact so the
            // next open takes the cheap stored-SHA path.
            try {
              await deleteContactPhoto(userId, data.id);
            } catch {
              // If the storage object is already gone, just null the column.
              await supabaseAdmin
                .from("contacts")
                .update({
                  avatar_url: null,
                  avatar_source: "unknown",
                  updated_at: new Date().toISOString(),
                })
                .eq("id", data.id)
                .eq("user_id", userId);
            }
            await supabaseAdmin
              .from("contacts")
              .update({ company_logo_photo_sha: matchedSha })
              .eq("id", data.id)
              .eq("user_id", userId);
            effectiveAvatarUrl = null;
          }
        }
      } catch {
        avatarIsCompanyLogoSnapshot = false;
      }
    }
    return {
      contact: { ...contact, avatar_url: effectiveAvatarUrl },
      recentEmails: emails ?? [],
      phones: phones ?? [],
      emails: emailRows ?? [],
      companyDomain,
      companyId: linkedCompanyId,
      avatarIsCompanyLogoSnapshot,
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
          .refine((v) => v === undefined || v === null || /.+@.+\..+/.test(v), {
            message: "Enter a valid email address",
          })
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

    // Resolve company text → company_id (find-or-create).
    if ("company" in patch) {
      const { companyId, canonicalName } = await resolveContactCompany(
        { supabase, userId },
        patch.company ?? null,
      );
      (patch as Record<string, unknown>).company_id = companyId;
      if (canonicalName) patch.company = canonicalName;
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

    // Merge tracked fields the user just set into `manual_overrides` so
    // enrichment leaves them alone next time. Use the full user-supplied
    // patch (plaintext + encrypted + `data`) so encrypted fields lock too.
    const { data: existingOverridesRow } = await supabase
      .from("contacts")
      .select("manual_overrides")
      .eq("id", id)
      .maybeSingle();
    const nextOverrides = computeManualOverrides(
      (existingOverridesRow as { manual_overrides?: string[] | null } | null)?.manual_overrides ??
        [],
      { ...data, ...encryptedPatch } as Record<string, unknown>,
    );
    (patch as Record<string, unknown>).manual_overrides = nextOverrides;

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

    // Evaluate per-label auto-assignment rules against the updated contact.
    try {
      await applyRulesForContact(supabase, userId, id);
    } catch {
      // rule evaluation is best-effort; never block a save.
    }

    // Return the decrypted view so the UI re-renders with the new
    // phone/notes/address values written through the encrypted RPC.
    const { row: decRow } = await getContactDecrypted(id);
    return {
      contact: decRow ?? updated,
      phones: refreshedPhones ?? [],
      emails: refreshedEmails ?? [],
    };
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
    // Bulk rename is an explicit user edit — lock `company` on every affected
    // contact so enrichment won't overwrite the new name later.
    await supabase.rpc("add_manual_overrides", {
      p_ids: data.contactIds,
      p_fields: ["company"],
    });
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
    if (value) {
      // Only lock when the user set a website. Clearing it should re-open
      // the field to enrichment.
      await supabase.rpc("add_manual_overrides", {
        p_ids: data.contactIds,
        p_fields: ["website"],
      });
    }
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
    const { userId, supabase } = context;
    // Resolve company text → company_id (find-or-create).
    const { companyId, canonicalName } = data.company
      ? await resolveContactCompany({ supabase, userId }, data.company)
      : { companyId: null as string | null, canonicalName: null as string | null };
    // phone / notes live in encrypted columns only after Phase 3.
    const overrides = computeManualOverrides([], data as Record<string, unknown>);
    const payload = {
      user_id: userId,
      email: data.email,
      name: normalizeName(data.name ?? null),
      title: data.title || null,
      company: canonicalName ?? data.company ?? null,
      company_id: companyId,
      website: data.website || null,
      linkedin: data.linkedin || null,
      twitter: data.twitter || null,
      source: "manual",
      manual_overrides: overrides,
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
    if (row?.id) {
      try {
        await applyRulesForContact(supabase, userId, row.id);
      } catch {
        // best-effort
      }
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

/**
 * Unlock one or more fields for enrichment. Removes the named entries from
 * `contacts.manual_overrides` so the next enrichment run is allowed to fill
 * them again. RLS scopes the update to the caller's own contact.
 */
export const clearContactManualOverrides = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        fields: z.array(z.enum(MANUAL_TRACKED_FIELDS)).min(1),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: row, error: readErr } = await supabase
      .from("contacts")
      .select("manual_overrides")
      .eq("id", data.id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!row) throw new Error("Contact not found");
    const drop = new Set<string>(data.fields);
    const next = (row.manual_overrides ?? []).filter((f) => !drop.has(f));
    const { error: updErr } = await supabase
      .from("contacts")
      .update({ manual_overrides: next })
      .eq("id", data.id);
    if (updErr) throw new Error(updErr.message);
    return { manual_overrides: next };
  });
