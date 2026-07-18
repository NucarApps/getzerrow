// Shared helper: build the set of SHA-256 hashes for every company logo the
// user has currently chosen (explicit picks + company_domains fallbacks).
// Used by both the cleanup batch and the CardDAV PUT guard so iOS "echoes"
// of any known company logo are recognized and never promoted into
// `contacts.avatar_url`.
//
// A tiny per-user in-memory TTL cache keeps the CardDAV PUT hot path cheap:
// logo bytes rarely change and we don't want to hammer the logo providers
// on every incoming photo write.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchChosenCompanyLogoBytes } from "@/lib/contacts/logo-photo.server";
import { sha256Hex } from "@/lib/contacts/photos.server";

type CacheEntry = { shas: Set<string>; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;

export function invalidateKnownCompanyLogoShaCache(userId: string): void {
  cache.delete(userId);
}

export async function buildKnownCompanyLogoShaSet(
  userId: string,
  opts: { useCache?: boolean } = {},
): Promise<Set<string>> {
  const useCache = opts.useCache ?? true;
  const now = Date.now();
  if (useCache) {
    const hit = cache.get(userId);
    if (hit && hit.expiresAt > now) return hit.shas;
  }

  // Prefer explicit user picks; they're the ones iOS most often echoes back.
  const primary = new Set<string>();
  const secondary = new Set<string>();

  const { data: choices } = await supabaseAdmin
    .from("company_logo_choices")
    .select("domain,source_domain")
    .eq("user_id", userId);
  for (const row of choices ?? []) {
    const choice = row as { domain?: string | null; source_domain?: string | null };
    if (choice.domain) primary.add(choice.domain.toLowerCase());
    if (choice.source_domain) primary.add(choice.source_domain.toLowerCase());
  }

  const { data: cdomains } = await supabaseAdmin
    .from("company_domains")
    .select("domain")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(120);
  for (const row of cdomains ?? []) {
    const d = (row as { domain?: string | null }).domain;
    if (d && !primary.has(d.toLowerCase())) secondary.add(d.toLowerCase());
  }

  // Hard cap total domains scanned per call so a tenant with hundreds of
  // auto-discovered domains can't stall the CardDAV PUT hot path.
  const MAX_DOMAINS = 60;
  const CONCURRENCY = 6;
  const FETCH_TIMEOUT_MS = 2000;
  const ordered = [...primary, ...secondary].slice(0, MAX_DOMAINS);

  const shas = new Set<string>();
  async function hashDomain(domain: string): Promise<void> {
    try {
      const hit = await Promise.race<
        Awaited<ReturnType<typeof fetchChosenCompanyLogoBytes>> | null
      >([
        fetchChosenCompanyLogoBytes(userId, domain),
        new Promise((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
      ]);
      if (hit) shas.add(await sha256Hex(hit.bytes));
    } catch {
      // Provider hiccups shouldn't poison the whole set.
    }
  }

  for (let i = 0; i < ordered.length; i += CONCURRENCY) {
    await Promise.all(ordered.slice(i, i + CONCURRENCY).map(hashDomain));
  }

  cache.set(userId, { shas, expiresAt: now + TTL_MS });
  return shas;
}
