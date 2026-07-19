// Server-only helper that fetches a company logo as raw bytes so we can
// inline it as a CardDAV `PHOTO` for contacts that don't have their own
// picture. Mirrors the provider/guard logic used by /api/public/logo, and
// keeps a small in-memory cache so filling a whole address book doesn't
// hammer upstream providers.
import { hostResolvesToPublicIp, isBlockedDomain, isValidDomainShape } from "@/lib/logo-guards";
import { contactLogoDomain } from "@/lib/company-domains";

const MIN_BYTES = 600;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;

type CacheEntry = { hit: { bytes: Uint8Array; mime: string } | null; expires: number };
const cache = new Map<string, CacheEntry>();

function readCache(key: string): CacheEntry | null {
  const e = cache.get(key);
  if (!e) return null;
  if (e.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return e;
}

function writeCache(key: string, hit: CacheEntry["hit"]): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { hit, expires: Date.now() + (hit ? HIT_TTL_MS : MISS_TTL_MS) });
}

/** Provider URLs in the same order as `LOGO_PROVIDER_LABELS` and the
 * `/api/public/logo` proxy. Keep in sync with both. */
function providersFor(domain: string): string[] {
  const d = encodeURIComponent(domain);
  const size = 256;
  const logoDevToken = process.env.LOGO_DEV_TOKEN;
  return [
    `https://img.logo.dev/${d}?size=${size}&format=png${
      logoDevToken ? `&token=${encodeURIComponent(logoDevToken)}` : ""
    }`,
    `https://logo.clearbit.com/${d}?size=${size}`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://${domain}/apple-touch-icon.png`,
    `https://${domain}/apple-touch-icon-precomposed.png`,
    `https://${domain}/favicon.ico`,
    `https://www.google.com/s2/favicons?domain=${d}&sz=256`,
  ];
}

async function tryFetch(url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      const parsed = new URL(current);
      if (parsed.protocol !== "https:") return null;
      const host = parsed.hostname.toLowerCase();
      if (isBlockedDomain(host)) return null;
      if (!(await hostResolvesToPublicIp(host))) return null;

      const res = await fetch(current, {
        redirect: "manual",
        headers: { "user-agent": "Mozilla/5.0 ZerrowLogoBot" },
        signal: AbortSignal.timeout(4000),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) return null;
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!ct.startsWith("image/")) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength < MIN_BYTES) return null;
      const mime = ct.split(";")[0].trim() || "image/png";
      return { bytes: buf, mime };
    }
    return null;
  } catch {
    return null;
  }
}

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

/** Fetch the specific company logo the user picked in Zerrow
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

type ContactLogoRow = {
  id?: string | null;
  company_id?: string | null;
  website?: string | null;
  email?: string | null;
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
