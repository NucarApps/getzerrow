// Server-only helper that fetches a company logo as raw bytes so we can
// inline it as a CardDAV `PHOTO` for contacts that don't have their own
// picture. Mirrors the provider/guard logic used by /api/public/logo, and
// keeps a small in-memory cache so filling a whole address book doesn't
// hammer upstream providers.
import { isBlockedDomain, isValidDomainShape } from "@/lib/logo-guards";
import { contactLogoDomain } from "@/lib/company-domains";
import { providersFor, fetchLogoBytes as tryFetch, createLogoCache } from "@/lib/logo-fetch.server";

type LogoHit = { bytes: Uint8Array; mime: string };
const logoCache = createLogoCache<LogoHit>(500);
const readCache = (key: string) => logoCache.read(key);
const writeCache = (key: string, hit: LogoHit | null) => logoCache.write(key, hit);

/** Fetch a logo for `domain` and return bytes + mime, or null if none of the
 * providers succeeds. Cached in-memory. */
export async function fetchCompanyLogoBytes(
  domain: string | null,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (!domain) return null;
  const d = domain.toLowerCase();
  if (!isValidDomainShape(d) || isBlockedDomain(d)) return null;
  const cached = readCache(d);
  if (cached) return cached.hit;
  for (const url of providersFor(d)) {
    const hit = await tryFetch(url);
    if (hit) {
      writeCache(d, hit);
      return hit;
    }
  }
  writeCache(d, null);
  return null;
}

/** Fetch the specific company logo the user picked in Atzro
 * (`company_logo_choices` row for `domain`), falling back to the multi-provider
 * walk when there's no pick. This is what CardDAV and Google Contacts push to
 * iPhone / Google People so every contact under, e.g., Nissan gets the exact
 * Nissan logo the user chose. */
export async function fetchChosenCompanyLogoBytes(
  userId: string,
  domain: string | null,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (!domain) return null;
  const d = domain.toLowerCase();
  if (!isValidDomainShape(d) || isBlockedDomain(d)) return null;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: choices } = await supabaseAdmin
    .from("company_logo_choices")
    .select("domain, provider, source_domain")
    .eq("user_id", userId)
    .or(`domain.eq.${d},source_domain.eq.${d}`);
  const choice =
    (
      (choices ?? []) as Array<{
        domain?: string | null;
        provider?: number | null;
        source_domain?: string | null;
      }>
    ).find((row) => row.domain?.toLowerCase() === d) ??
    (
      (choices ?? []) as Array<{
        domain?: string | null;
        provider?: number | null;
        source_domain?: string | null;
      }>
    ).find((row) => row.source_domain?.toLowerCase() === d) ??
    null;

  if (!choice) return fetchCompanyLogoBytes(d);

  const provider = (choice as { provider?: number }).provider ?? 0;
  const source = ((choice as { source_domain?: string | null }).source_domain ?? d).toLowerCase();
  if (!isValidDomainShape(source) || isBlockedDomain(source)) {
    return fetchCompanyLogoBytes(d);
  }
  const urls = providersFor(source);
  const url = urls[provider];
  if (!url) return fetchCompanyLogoBytes(d);
  const key = `${userId}:${d}:${provider}:${source}`;
  const cached = readCache(key);
  if (cached) return cached.hit;
  const hit = await tryFetch(url);
  writeCache(key, hit);
  // If the exact pick failed (dead provider), don't strand the contact — fall
  // through to the generic walker so the phone still gets some logo.
  return hit ?? (await fetchCompanyLogoBytes(d));
}

/** Company logo bytes with the custom uploaded photo taking priority over the
 *  picked/auto brand logo. When a company has an uploaded `logo_url`, serve
 *  that; otherwise fall back to the domain-based brand pick/walk. This is the
 *  single resolver CardDAV (and web fallbacks) use so a custom company photo
 *  cascades to every member without their own avatar. */
export async function fetchCompanyPhotoOrLogoBytes(
  userId: string,
  opts: { companyId?: string | null; domain: string | null },
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (opts.companyId) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("companies")
      .select("logo_url")
      .eq("id", opts.companyId)
      .eq("user_id", userId)
      .maybeSingle();
    const logoUrl = (data as { logo_url?: string | null } | null)?.logo_url ?? null;
    if (logoUrl) {
      const { loadCompanyPhotoBytes } = await import("@/lib/companies/company-photo.server");
      const custom = await loadCompanyPhotoBytes(logoUrl);
      if (custom) return custom;
    }
  }
  return fetchChosenCompanyLogoBytes(userId, opts.domain);
}

type ContactLogoRow = {
  id?: string | null;
  company_id?: string | null;
  website?: string | null;
  email?: string | null;
};

export type EffectiveContactPhotoSource =
  "contact_avatar" | "company_photo" | "company_domain_logo";

export type EffectiveContactPhoto = {
  bytes: Uint8Array;
  mime: string;
  etag: string;
  source: EffectiveContactPhotoSource;
  avatarUrl: string | null;
  companyId: string | null;
  companyLogoUrl: string | null;
  domain: string | null;
  sha256: string | null;
};

type CompanyDomainRow = {
  domain: string;
  source?: string | null;
  member_count?: number | null;
  created_at?: string | null;
};

type LogoChoiceRow = {
  domain: string;
  source_domain: string | null;
};

export async function recordCompanyLogoHash(args: {
  userId: string;
  companyId: string | null;
  domain: string | null;
  sha256: string;
  source?: string;
}): Promise<void> {
  if (!args.companyId || !args.sha256) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("company_logo_hashes").upsert(
    {
      user_id: args.userId,
      company_id: args.companyId,
      domain: args.domain?.toLowerCase() ?? null,
      sha256: args.sha256,
      source: args.source ?? "observed",
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "user_id,company_id,sha256" },
  );
}

export async function getKnownCompanyLogoHashes(
  userId: string,
  companyId?: string | null,
): Promise<Set<string>> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  let query = supabaseAdmin.from("company_logo_hashes").select("sha256").eq("user_id", userId);
  if (companyId) query = query.eq("company_id", companyId);
  const { data } = await query.limit(5000);
  return new Set(((data as Array<{ sha256: string }> | null) ?? []).map((row) => row.sha256));
}

function sortedCompanyDomains(rows: CompanyDomainRow[]): string[] {
  return rows
    .slice()
    .sort((a, b) => {
      const sourceRank = (b.source === "manual" ? 1 : 0) - (a.source === "manual" ? 1 : 0);
      if (sourceRank !== 0) return sourceRank;
      const memberRank = (b.member_count ?? 0) - (a.member_count ?? 0);
      if (memberRank !== 0) return memberRank;
      return (a.created_at ?? "").localeCompare(b.created_at ?? "");
    })
    .map((row) => row.domain.toLowerCase());
}

/** Resolve the logo domain from the linked company record, not just the
 * contact's own email/website. This covers companies with both a manual domain
 * and an auto-discovered email domain where the saved logo choice may be keyed
 * to either side of the alias pair. */
export async function resolveCompanyLogoDomainForContact(
  userId: string,
  row: ContactLogoRow,
): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  let companyId = row.company_id ?? null;
  if (!companyId && row.id) {
    const { data } = await supabaseAdmin
      .from("contacts")
      .select("company_id")
      .eq("id", row.id)
      .eq("user_id", userId)
      .maybeSingle();
    companyId = (data as { company_id?: string | null } | null)?.company_id ?? null;
  }

  if (!companyId) return logoDomainForContact(row);

  const { data: domainRows } = await supabaseAdmin
    .from("company_domains")
    .select("domain,source,member_count,created_at")
    .eq("company_id", companyId)
    .eq("user_id", userId);

  const domainList = sortedCompanyDomains((domainRows ?? []) as CompanyDomainRow[]);
  if (domainList.length === 0) return logoDomainForContact(row);

  const { data: choices } = await supabaseAdmin
    .from("company_logo_choices")
    .select("domain,source_domain")
    .eq("user_id", userId);
  const domainSet = new Set(domainList);
  const choice = ((choices ?? []) as LogoChoiceRow[]).find(
    (candidate) =>
      domainSet.has(candidate.domain.toLowerCase()) ||
      (candidate.source_domain ? domainSet.has(candidate.source_domain.toLowerCase()) : false),
  );

  return (
    choice?.source_domain?.toLowerCase() ?? choice?.domain?.toLowerCase() ?? domainList[0] ?? null
  );
}

/** Best-guess logo domain for a contact row (website beats email). Returns
 * null for personal-email-only contacts (gmail, icloud, etc.). */
export function logoDomainForContact(row: {
  website?: string | null;
  email?: string | null;
}): string | null {
  return contactLogoDomain(row.website ?? null, row.email ?? null);
}

/** Resolve the actual photo bytes that should be pushed to external contact
 *  stores. A contact portrait wins; otherwise members inherit the linked
 *  company's uploaded logo, then the chosen/domain logo Atzro displays. */
export async function resolveEffectiveContactPhotoForSync(
  userId: string,
  contactId: string,
): Promise<EffectiveContactPhoto | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: contact } = await supabaseAdmin
    .from("contacts")
    .select("id,avatar_url,company_id,website,email")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();
  const row = contact as {
    id?: string | null;
    avatar_url?: string | null;
    company_id?: string | null;
    website?: string | null;
    email?: string | null;
  } | null;
  if (!row?.id) return null;

  const avatarUrl = row.avatar_url ?? null;
  const companyId = row.company_id ?? null;

  const { getEffectivePhotoPriority } = await import("@/lib/contacts/photo-priority.server");
  const { priority } = await getEffectivePhotoPriority(userId, row.id);

  const tryPersonal = async (): Promise<EffectiveContactPhoto | null> => {
    if (!avatarUrl) return null;
    const { loadContactPhotoBytes } = await import("@/lib/contacts/photos.server");
    const avatar = await loadContactPhotoBytes(avatarUrl);
    if (!avatar) return null;
    return {
      ...avatar,
      etag: avatarUrl,
      source: "contact_avatar",
      avatarUrl,
      companyId,
      companyLogoUrl: null,
      domain: null,
      sha256: null,
    };
  };

  const tryCompany = async (): Promise<EffectiveContactPhoto | null> => {
    let companyLogoUrl: string | null = null;
    if (companyId) {
      const { data: company } = await supabaseAdmin
        .from("companies")
        .select("logo_url")
        .eq("id", companyId)
        .eq("user_id", userId)
        .maybeSingle();
      companyLogoUrl = (company as { logo_url?: string | null } | null)?.logo_url ?? null;
      if (companyLogoUrl) {
        const { loadCompanyPhotoBytes } = await import("@/lib/companies/company-photo.server");
        const logo = await loadCompanyPhotoBytes(companyLogoUrl);
        if (logo) {
          const { sha256Hex } = await import("@/lib/contacts/photos.server");
          const sha = await sha256Hex(logo.bytes);
          await recordCompanyLogoHash({
            userId,
            companyId,
            domain: null,
            sha256: sha,
            source: "google_push_company_photo",
          });
          return {
            ...logo,
            etag: `company-photo:${companyId}:${sha}`,
            source: "company_photo",
            avatarUrl,
            companyId,
            companyLogoUrl,
            domain: null,
            sha256: sha,
          };
        }
      }
    }

    const domain = await resolveCompanyLogoDomainForContact(userId, {
      id: row.id,
      company_id: companyId,
      website: row.website ?? null,
      email: row.email ?? null,
    });
    const domainLogo = await fetchChosenCompanyLogoBytes(userId, domain);
    if (!domainLogo) return null;

    const { sha256Hex } = await import("@/lib/contacts/photos.server");
    const sha = await sha256Hex(domainLogo.bytes);
    await recordCompanyLogoHash({
      userId,
      companyId,
      domain,
      sha256: sha,
      source: "google_push_domain_logo",
    });
    return {
      ...domainLogo,
      etag: `company-domain-logo:${companyId ?? "none"}:${domain ?? "none"}:${sha}`,
      source: "company_domain_logo",
      avatarUrl,
      companyId,
      companyLogoUrl,
      domain,
      sha256: sha,
    };
  };

  if (priority === "personal_only") {
    return await tryPersonal();
  }
  if (priority === "personal_first") {
    return (await tryPersonal()) ?? (await tryCompany());
  }
  // company_first (default)
  return (await tryCompany()) ?? (await tryPersonal());
}

/** Walk every provider variant for every domain linked to `companyId` and
 * return the first SHA-256 that matches `targetSha`. Used by `getContact` to
 * detect a stale iOS/Google snapshot of a *previously* chosen logo — the
 * current-pick comparison can miss it when the user has since swapped
 * providers or the pick returns different bytes today.
 *
 * Bounded by design: one company × its domains × 7 providers, all cached in
 * the module-level logo byte cache, so a hit on a re-open is instant. */
/** Hash every provider variant for every domain linked to `companyId` and
 * return the full set (recorded hashes included). Used by the bulk logo
 * cleanup so a batch walks each company's providers ONCE instead of once
 * per contact. Same fetch budget as findMatchingCompanyLogoSha. */
export async function getCompanyLogoVariantShas(
  userId: string,
  companyId: string,
  computeSha: (bytes: Uint8Array) => Promise<string>,
): Promise<Set<string>> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const shas = await getKnownCompanyLogoHashes(userId, companyId);

  const { data: domainRows } = await supabaseAdmin
    .from("company_domains")
    .select("domain,source,member_count,created_at")
    .eq("company_id", companyId)
    .eq("user_id", userId);
  const domains = sortedCompanyDomains((domainRows ?? []) as CompanyDomainRow[]);

  const MAX_FETCHES = 20;
  let budget = MAX_FETCHES;
  for (const domain of domains) {
    if (!isValidDomainShape(domain) || isBlockedDomain(domain)) continue;
    for (const url of providersFor(domain)) {
      if (budget-- <= 0) return shas;
      const hit = await tryFetch(url);
      if (hit) shas.add(await computeSha(hit.bytes));
    }
  }
  return shas;
}

export async function findMatchingCompanyLogoSha(
  userId: string,
  companyId: string,
  targetSha: string,
  computeSha: (bytes: Uint8Array) => Promise<string>,
): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const known = await getKnownCompanyLogoHashes(userId, companyId);
  if (known.has(targetSha)) return targetSha;

  const { data: domainRows } = await supabaseAdmin
    .from("company_domains")
    .select("domain,source,member_count,created_at")
    .eq("company_id", companyId)
    .eq("user_id", userId);

  const domains = sortedCompanyDomains((domainRows ?? []) as CompanyDomainRow[]);
  if (domains.length === 0) return null;

  const MAX_FETCHES = 20;
  let budget = MAX_FETCHES;
  for (const domain of domains) {
    if (!isValidDomainShape(domain) || isBlockedDomain(domain)) continue;
    for (const url of providersFor(domain)) {
      if (budget-- <= 0) return null;
      const hit = await tryFetch(url);
      if (!hit) continue;
      const sha = await computeSha(hit.bytes);
      if (sha === targetSha) {
        await recordCompanyLogoHash({
          userId,
          companyId,
          domain,
          sha256: sha,
          source: "provider_probe",
        });
        return sha;
      }
    }
  }
  return null;
}
