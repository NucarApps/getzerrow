/**
 * Shared label-identity key. One label name → one key, so every path that
 * creates labels (manual create, auto company subgroups, Google group
 * import, CardDAV CATEGORIES, suggestion apply, company linking) lands on
 * the same row instead of minting a near-duplicate ("Nissan" vs
 * "Nissan, Inc." vs "Nissan Motor Acceptance Company").
 *
 * Chain: mild normalize → company_name_aliases canonicalization →
 * aggressive brand-key normalize (mild as fallback). Pure — the server
 * resolver (label-resolve.server.ts) loads the inputs.
 */
import { normalizeCompanyName } from "./company-name";
import { normalizeCompanyName as mildNormalizeCompanyName } from "@/lib/companies/normalize";

export function deriveLabelKey(
  name: string,
  nameAliases: Map<string, string> = new Map(),
): { key: string | null; viaAlias: boolean } {
  const mild = mildNormalizeCompanyName(name);
  const canonical = mild ? nameAliases.get(mild) : undefined;
  const base = canonical ?? name;
  const key = normalizeCompanyName(base) ?? mildNormalizeCompanyName(base);
  return { key, viaAlias: !!canonical };
}

export type LabelCandidate = {
  id: string;
  name: string;
  parent_group_id: string | null;
  member_count?: number;
};

/** Find the existing label `rawName` should resolve to within `parentGroupId`
 * scope, or null when a new label is genuinely needed. Preference order:
 * exact case-insensitive name match, then most members, then shortest name
 * (usually the umbrella brand). */
export function pickExistingLabel<L extends LabelCandidate>(
  rawName: string,
  parentGroupId: string | null,
  labels: L[],
  nameAliases: Map<string, string> = new Map(),
): L | null {
  const { key } = deriveLabelKey(rawName, nameAliases);
  if (!key) return null;
  const exactName = rawName.trim().toLowerCase();
  const inScope = labels.filter(
    (l) =>
      (l.parent_group_id ?? null) === (parentGroupId ?? null) &&
      deriveLabelKey(l.name, nameAliases).key === key,
  );
  if (inScope.length === 0) return null;
  const exact = inScope.find((l) => l.name.trim().toLowerCase() === exactName);
  if (exact) return exact;
  return inScope.slice().sort((a, b) => {
    const ma = a.member_count ?? 0;
    const mb = b.member_count ?? 0;
    if (mb !== ma) return mb - ma;
    return a.name.length - b.name.length;
  })[0];
}
