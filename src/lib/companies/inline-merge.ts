import { normalizeCompanyName } from "@/lib/contacts/company-name";

export type InlineMergeContact = {
  id: string;
  company?: string | null;
};

export type InlineMergeBucket = {
  key: string;
  domain: string | null;
  name: string;
  kind: "company" | "personal" | "other";
  contacts: InlineMergeContact[];
  companyId?: string;
};

export type InlineCompanyMergeSuggestion = {
  kind: "company" | "alias" | "rename";
  normalizedName: string;
  displayName: string;
  primaryBucketKey: string;
  primaryDomain: string;
  primaryCompanyId: string | null;
  sourceCompanyIds: string[];
  aliasDomains: string[];
  /** Contact IDs from non-primary buckets, used for rename-mode merges. */
  aliasContactIds: string[];
  otherCount: number;
};

type MergeEntryBucket = {
  key: string;
  domain: string;
  contacts: InlineMergeContact[];
  companyId: string | null;
};

export function buildInlineCompanyMergeSuggestions(
  companyBuckets: InlineMergeBucket[],
  dismissedNames: ReadonlySet<string> = new Set(),
): Map<string, InlineCompanyMergeSuggestion> {
  const byName = new Map<string, { displayName: string; buckets: MergeEntryBucket[] }>();
  for (const bucket of companyBuckets) {
    if (bucket.kind !== "company" || !bucket.domain) continue;
    const counts = new Map<string, number>();
    for (const contact of bucket.contacts) {
      const name = (contact.company ?? "").trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    let dominant = bucket.name;
    let best = 0;
    for (const [name, count] of counts) {
      if (count > best) {
        best = count;
        dominant = name;
      }
    }
    const normalizedName = normalizeCompanyName(dominant);
    if (!normalizedName) continue;
    const entry = byName.get(normalizedName) ?? { displayName: dominant, buckets: [] };
    entry.buckets.push({
      key: bucket.key,
      domain: bucket.domain,
      contacts: bucket.contacts,
      companyId: bucket.companyId ?? null,
    });
    byName.set(normalizedName, entry);
  }

  const suggestions = new Map<string, InlineCompanyMergeSuggestion>();
  for (const [normalizedName, entry] of byName) {
    if (entry.buckets.length < 2) continue;
    if (dismissedNames.has(normalizedName)) continue;
    const sorted = [...entry.buckets].sort(
      (a, b) => b.contacts.length - a.contacts.length || a.domain.localeCompare(b.domain),
    );
    const primary = sorted[0];
    const others = sorted.slice(1);
    const aliasDomains = Array.from(
      new Set(others.map((bucket) => bucket.domain).filter((domain) => domain !== primary.domain)),
    );
    const sourceCompanyIds = Array.from(
      new Set(
        others
          .map((bucket) => bucket.companyId)
          .filter((id): id is string => !!id && id !== primary.companyId),
      ),
    );
    const suggestion: InlineCompanyMergeSuggestion = {
      kind:
        primary.companyId && sourceCompanyIds.length > 0
          ? "company"
          : aliasDomains.length > 0
            ? "alias"
            : "rename",
      normalizedName,
      displayName: entry.displayName,
      primaryBucketKey: primary.key,
      primaryDomain: primary.domain,
      primaryCompanyId: primary.companyId,
      sourceCompanyIds,
      aliasDomains,
      aliasContactIds: others.flatMap((bucket) => bucket.contacts.map((contact) => contact.id)),
      otherCount: others.length,
    };
    for (const bucket of entry.buckets) suggestions.set(bucket.key, suggestion);
  }
  return suggestions;
}
