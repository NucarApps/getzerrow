/**
 * Pure clustering logic for contact duplicate detection. Blocks candidate
 * contacts into clusters by deterministic signals (shared phone, name+email
 * local-part, etc.) and picks the primary row of each cluster.
 *
 * Kept pure (no supabase, no AI) so it's unit-testable; the background scan
 * (dedup.functions.ts) loads the inputs and judges ambiguous clusters.
 */
import { normalizePhone } from "./phone";
import { emailLocalPart, firstLastTokens, normalizeNameLoose } from "./name-match";

export type ContactRow = {
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  title: string | null;
  city: string | null;
  source: string | null;
  created_at: string;
};

export type PhoneRow = { contact_id: string; number: string };

export type ContactWithPhones = ContactRow & { phones: string[] };

export type ClusterSignal =
  | "exact_phone"
  | "name_phone"
  | "name_company"
  | "name_only"
  | "email_localpart"
  | "name_email_local"
  | "loose_name";

export type Cluster = {
  key: string;
  contacts: ContactWithPhones[];
  signal: ClusterSignal;
};

function normName(s: string | null | undefined): string {
  return normalizeNameLoose(s);
}

function firstLastKey(name: string | null | undefined): string | null {
  const tokens = firstLastTokens(name);
  if (!tokens) return null;
  const [f, l] = tokens;
  if (!f && !l) return null;
  return `${f}|${l}`;
}

export function buildClusters(all: ContactWithPhones[]): Cluster[] {
  const byPhone = new Map<string, ContactWithPhones[]>();
  const byNameCompany = new Map<string, ContactWithPhones[]>();
  const byName = new Map<string, ContactWithPhones[]>();
  const byLooseName = new Map<string, ContactWithPhones[]>();
  const byEmailLocal = new Map<string, ContactWithPhones[]>();
  const byNameEmailLocal = new Map<string, ContactWithPhones[]>();

  for (const c of all) {
    const name = normName(c.name);
    const company = normName(c.company);
    const loose = firstLastKey(c.name);
    const local = emailLocalPart(c.email);

    for (const raw of c.phones) {
      const n = normalizePhone(raw);
      if (!n) continue;
      const list = byPhone.get(n) ?? [];
      list.push(c);
      byPhone.set(n, list);
    }
    if (name && company) {
      const k = `${name}|${company}`;
      const list = byNameCompany.get(k) ?? [];
      list.push(c);
      byNameCompany.set(k, list);
    }
    if (name) {
      const list = byName.get(name) ?? [];
      list.push(c);
      byName.set(name, list);
    }
    if (loose) {
      const list = byLooseName.get(loose) ?? [];
      list.push(c);
      byLooseName.set(loose, list);
    }
    if (local && local.length >= 3) {
      const list = byEmailLocal.get(local) ?? [];
      list.push(c);
      byEmailLocal.set(local, list);
    }
    if (loose && local && local.length >= 3) {
      const k = `${loose}|${local}`;
      const list = byNameEmailLocal.get(k) ?? [];
      list.push(c);
      byNameEmailLocal.set(k, list);
    }
  }

  const clusters: Cluster[] = [];
  const seen = new Set<string>();

  function pushCluster(members: ContactWithPhones[], signal: ClusterSignal, key: string) {
    if (members.length < 2) return;
    const uniq = new Map<string, ContactWithPhones>();
    for (const m of members) uniq.set(m.id, m);
    if (uniq.size < 2) return;
    const idKey = Array.from(uniq.keys()).sort().join(",");
    if (seen.has(idKey)) return;
    seen.add(idKey);
    clusters.push({ key, contacts: Array.from(uniq.values()), signal });
  }

  // Strong signals first so overlapping id-sets get the higher-priority label.
  for (const [k, list] of byPhone) pushCluster(list, "exact_phone", `phone:${k}`);
  for (const [k, list] of byNameEmailLocal) pushCluster(list, "name_email_local", `nel:${k}`);
  for (const [k, list] of byEmailLocal) {
    // Only interesting if the local-part appears on ≥2 different domains.
    const domains = new Set(
      list.map((c) => (c.email ?? "").split("@")[1]?.toLowerCase()).filter(Boolean),
    );
    if (domains.size >= 2) pushCluster(list, "email_localpart", `elp:${k}`);
  }
  for (const [k, list] of byNameCompany) pushCluster(list, "name_company", `nc:${k}`);
  for (const [k, list] of byName) {
    const uniqEmails = new Set(list.map((c) => (c.email ?? "").toLowerCase()).filter(Boolean));
    if (uniqEmails.size > 1 || list.some((c) => !c.email)) {
      pushCluster(list, "name_only", `name:${k}`);
    }
  }
  for (const [k, list] of byLooseName) {
    // Loose name (first+last tokens) catches "John A Smith" vs "John Smith".
    pushCluster(list, "loose_name", `ln:${k}`);
  }
  return clusters;
}

/** Which contact to promote as the "primary" of a merge. */
export function pickPrimary(cluster: ContactWithPhones[]): ContactWithPhones {
  const sorted = [...cluster].sort((a, b) => {
    // Prefer rows with an email
    const ae = a.email ? 1 : 0;
    const be = b.email ? 1 : 0;
    if (ae !== be) return be - ae;
    // Then richness (count of non-null fields)
    const score = (c: ContactWithPhones) =>
      [c.name, c.company, c.title, c.city].filter(Boolean).length + c.phones.length;
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sb - sa;
    // Oldest wins as tiebreaker (stable id)
    return a.created_at.localeCompare(b.created_at);
  });
  return sorted[0];
}

/**
 * Deterministically truncate a cluster's members. The kept subset must not
 * depend on query row order, or the primary of an oversized cluster (and
 * with it the dismissed-suggestion guard, keyed by primary) shifts between
 * rescans.
 */
export function truncateMembers(
  members: ContactWithPhones[],
  maxClusterSize: number,
): ContactWithPhones[] {
  return [...members]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .slice(0, maxClusterSize);
}
