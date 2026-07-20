// Server fns for un-freezing company-logo snapshots that iOS accidentally
// promoted into a contact's real avatar (see plan: company-logo photo
// round-trip). Walk the caller's contacts, and for any whose stored
// `avatar_url` bytes match ANY known company logo bytes (this contact's
// own company, or any other company the user has picked a logo for), clear
// the avatar so the CardDAV/UI fallback flows through the live logo again.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listContactsForLogoCleanup = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ ids: string[] }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("user_id", context.userId)
      .not("avatar_url", "is", null)
      .not("company_id", "is", null)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return { ids: (data ?? []).map((r) => (r as { id: string }).id) };
  });

/** Build a set of SHA-256 hashes for every company logo the user has
 * currently chosen. Used by the cleanup to detect stale historical logo
 * snapshots (e.g. a Nissan logo pinned onto a contact now under Fenway). */
async function buildKnownCompanyLogoShaSet(userId: string): Promise<Set<string>> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { fetchChosenCompanyLogoBytes } = await import("@/lib/contacts/logo-photo.server");
  const { sha256Hex } = await import("@/lib/contacts/photos.server");

  const domains = new Set<string>();

  const { data: choices } = await supabaseAdmin
    .from("company_logo_choices")
    .select("domain,source_domain")
    .eq("user_id", userId);
  for (const row of choices ?? []) {
    const choice = row as { domain?: string | null; source_domain?: string | null };
    const d = choice.domain;
    if (d) domains.add(d.toLowerCase());
    if (choice.source_domain) domains.add(choice.source_domain.toLowerCase());
  }

  // Also cover companies with a domain but no explicit choice — the fallback
  // walker still produces a specific logo we might have inlined previously.
  const { data: cdomains } = await supabaseAdmin
    .from("company_domains")
    .select("domain")
    .eq("user_id", userId);
  for (const row of cdomains ?? []) {
    const d = (row as { domain?: string | null }).domain;
    if (d) domains.add(d.toLowerCase());
  }

  const shas = new Set<string>();
  // Fetch sequentially — small N, avoids hammering logo providers.
  for (const domain of domains) {
    try {
      const hit = await fetchChosenCompanyLogoBytes(userId, domain);
      if (hit) shas.add(await sha256Hex(hit.bytes));
    } catch {
      // Skip — provider hiccups shouldn't abort the whole cleanup.
    }
  }
  return shas;
}

export const cleanupCompanyLogoPhotosBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ ids: z.array(z.string().uuid()).min(1).max(20) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadContactPhotoBytes, deleteContactPhoto, sha256Hex } =
      await import("@/lib/contacts/photos.server");
    const { fetchChosenCompanyLogoBytes, resolveCompanyLogoDomainForContact } =
      await import("@/lib/contacts/logo-photo.server");

    const { data: rows, error } = await supabaseAdmin
      .from("contacts")
      .select("id,avatar_url,email,website,company_id")
      .in("id", data.ids)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);

    const knownLogoShas = await buildKnownCompanyLogoShaSet(context.userId);
    const { getCompanyLogoVariantShas, getKnownCompanyLogoHashes, recordCompanyLogoHash } =
      await import("@/lib/contacts/logo-photo.server");
    const recordedShas = await getKnownCompanyLogoHashes(context.userId);
    // Provider-variant hashes per company, walked at most once per batch —
    // 10 contacts at one company must not fetch the same 7 URLs 10 times.
    const variantShasByCompany = new Map<string, Set<string>>();
    const variantShasFor = async (companyId: string): Promise<Set<string>> => {
      let set = variantShasByCompany.get(companyId);
      if (!set) {
        set = await getCompanyLogoVariantShas(context.userId, companyId, sha256Hex);
        variantShasByCompany.set(companyId, set);
      }
      return set;
    };

    let cleared = 0;
    const kept: string[] = [];
    for (const row of rows ?? []) {
      const r = row as {
        id: string;
        avatar_url: string | null;
        email: string | null;
        website: string | null;
        company_id: string | null;
      };
      // Hash-gated, not source-exempted (matches the getContact self-heal):
      // legacy iOS logo echoes arrive mislabeled user_upload/carddav, and a
      // genuine portrait can never byte-match a known logo.
      if (!r.avatar_url || !r.company_id) {
        kept.push(r.id);
        continue;
      }
      const own = await loadContactPhotoBytes(r.avatar_url);
      if (!own) {
        kept.push(r.id);
        continue;
      }
      const ownSha = await sha256Hex(own.bytes);

      // Current-company logo SHA (may be null if provider failed).
      const logoDomain = await resolveCompanyLogoDomainForContact(context.userId, r);
      const currentLogo = await fetchChosenCompanyLogoBytes(context.userId, logoDomain);
      const currentLogoSha = currentLogo ? await sha256Hex(currentLogo.bytes) : null;

      // Clear if the stored avatar matches THIS contact's current logo, OR
      // matches any other known company-logo the user has picked (a stale
      // snapshot from a previous mis-association), OR any recorded logo hash,
      // OR any provider variant of the contact's company domains (providers
      // re-render images over time, so today's chosen-variant bytes can miss
      // a snapshot taken months ago). Cheap set checks run first; the
      // provider walk is once-per-company per batch.
      const matches =
        (currentLogoSha && ownSha === currentLogoSha) ||
        knownLogoShas.has(ownSha) ||
        recordedShas.has(ownSha) ||
        (await variantShasFor(r.company_id)).has(ownSha);

      if (matches && !recordedShas.has(ownSha)) {
        // Fingerprint the match so future getContact opens take the cheap
        // recorded-hash path instead of re-walking providers.
        await recordCompanyLogoHash({
          userId: context.userId,
          companyId: r.company_id,
          domain: logoDomain,
          sha256: ownSha,
          source: "bulk_cleanup",
        });
        recordedShas.add(ownSha);
      }

      if (matches) {
        await deleteContactPhoto(context.userId, r.id);
        // Stamp with the current company's logo SHA so the CardDAV PUT
        // guard recognizes future echoes and doesn't re-promote them.
        if (currentLogoSha) {
          await supabaseAdmin
            .from("contacts")
            .update({ company_logo_photo_sha: currentLogoSha })
            .eq("id", r.id)
            .eq("user_id", context.userId);
        }
        // Nudge Google sync so the corrected logo repushes.
        try {
          const { markGoogleContactDirty } =
            await import("@/lib/google-contacts/mark-dirty.server");
          await markGoogleContactDirty(context.userId, r.id);
        } catch {
          // ignore
        }
        cleared += 1;
      } else {
        kept.push(r.id);
      }
    }

    if (cleared > 0) {
      // Bump the CardDAV resync nonce so iPhone re-pulls fresh vCards.
      const { data: existing } = await supabaseAdmin
        .from("carddav_settings")
        .select("resync_nonce")
        .eq("user_id", context.userId)
        .maybeSingle();
      const next = ((existing as { resync_nonce?: number } | null)?.resync_nonce ?? 0) + 1;
      await supabaseAdmin
        .from("carddav_settings")
        .upsert({ user_id: context.userId, resync_nonce: next }, { onConflict: "user_id" });
    }

    return { cleared, kept: kept.length };
  });

/** Per-contact escape hatch: unconditionally clear the stored avatar for a
 * single contact so the UI/CardDAV fallback flows through the live company
 * logo. Requires the contact to have a linked company. */
export const resetContactToCompanyLogo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ contactId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { deleteContactPhoto, sha256Hex } = await import("@/lib/contacts/photos.server");
    const { fetchChosenCompanyLogoBytes, resolveCompanyLogoDomainForContact } =
      await import("@/lib/contacts/logo-photo.server");

    const { data: row, error } = await supabaseAdmin
      .from("contacts")
      .select("id,avatar_url,email,website,company_id")
      .eq("id", data.contactId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Contact not found");
    const r = row as {
      id: string;
      avatar_url: string | null;
      email: string | null;
      website: string | null;
      company_id: string | null;
    };
    if (!r.company_id) throw new Error("Contact has no linked company");

    if (r.avatar_url) {
      await deleteContactPhoto(context.userId, r.id);
    }

    const logoDomain = await resolveCompanyLogoDomainForContact(context.userId, r);
    const logo = await fetchChosenCompanyLogoBytes(context.userId, logoDomain);
    const logoSha = logo ? await sha256Hex(logo.bytes) : null;
    if (logoSha) {
      await supabaseAdmin
        .from("contacts")
        .update({ company_logo_photo_sha: logoSha })
        .eq("id", r.id)
        .eq("user_id", context.userId);
    }

    // Nudge Google sync so the freshly-selected company logo repushes to
    // Google People (best-effort — no-op if the contact isn't linked).
    try {
      const { markGoogleContactDirty } = await import("@/lib/google-contacts/mark-dirty.server");
      await markGoogleContactDirty(context.userId, r.id);
    } catch {
      // ignore
    }

    // Bump resync nonce so iPhone re-pulls.
    const { data: existing } = await supabaseAdmin
      .from("carddav_settings")
      .select("resync_nonce")
      .eq("user_id", context.userId)
      .maybeSingle();
    const next = ((existing as { resync_nonce?: number } | null)?.resync_nonce ?? 0) + 1;
    await supabaseAdmin
      .from("carddav_settings")
      .upsert({ user_id: context.userId, resync_nonce: next }, { onConflict: "user_id" });

    return { ok: true as const };
  });
