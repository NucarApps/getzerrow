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

  const domains = new Set<string>();

  const { data: choices } = await supabaseAdmin
    .from("company_logo_choices")
    .select("domain")
    .eq("user_id", userId);
  for (const row of choices ?? []) {
    const d = (row as { domain?: string | null }).domain;
    if (d) domains.add(d.toLowerCase());
  }

  const { data: cdomains } = await supabaseAdmin
    .from("company_domains")
    .select("domain")
    .eq("user_id", userId);
  for (const row of cdomains ?? []) {
    const d = (row as { domain?: string | null }).domain;
    if (d) domains.add(d.toLowerCase());
  }

  const shas = new Set<string>();
  for (const domain of domains) {
    try {
      const hit = await fetchChosenCompanyLogoBytes(userId, domain);
      if (hit) shas.add(await sha256Hex(hit.bytes));
    } catch {
      // Provider hiccups shouldn't poison the whole set.
    }
  }

  cache.set(userId, { shas, expiresAt: now + TTL_MS });
  return shas;
}
