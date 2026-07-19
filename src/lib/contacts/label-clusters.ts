/**
 * Pure clustering of duplicate contact labels. Three deterministic signals,
 * strongest first, unioned within the same parent scope:
 *
 *  1. company link — labels whose members resolve to the SAME company row
 *     are the same label ("one company → one label"), regardless of name.
 *  2. alias-resolved name — a label named like a merged-away company
 *     variant ("Nissan Motor Acceptance Company") folds into the canonical
 *     company's label via company_name_aliases.
 *  3. aggressively-normalized name — "Nissan" / "Nissan North America" /
 *     "Nissan-USA" share a brand key even without company links.
 *
 * Kept pure (no supabase) so it's unit-testable; the server functions load
 * the inputs.
 */
import { deriveLabelKey } from "./label-resolve";

export type LabelClusterInput = {
  id: string;
  name: string;
  parent_group_id: string | null;
  auto_generated_from_group_id: string | null;
  member_count: number;
  /** Dominant member company (strict majority), when one exists. */
  company_id: string | null;
};

export type LabelCluster<L extends LabelClusterInput> = {
  labels: L[];
  reason: "company" | "alias" | "name";
};

const PARENT_ROOT = "__root__";

// Clustering key now shared with every label-create path — see
// label-resolve.ts. Kept as a local alias so call sites below read the same.
const nameKeyFor = deriveLabelKey;

export function clusterLabels<L extends LabelClusterInput>(
  labels: L[],
  nameAliases: Map<string, string> = new Map(),
): LabelCluster<L>[] {
  // Union-find over label ids.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (!p || p === x) {
      parent.set(x, x);
      return x;
    }
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const l of labels) parent.set(l.id, l.id);

  const companyBuckets = new Map<string, string[]>();
  const nameBuckets = new Map<string, string[]>();
  const viaAliasIds = new Set<string>();
  const companyJoinedIds = new Set<string>();

  for (const l of labels) {
    const scope = l.parent_group_id ?? PARENT_ROOT;
    if (l.company_id) {
      const key = `${scope}::c:${l.company_id}`;
      const arr = companyBuckets.get(key) ?? [];
      arr.push(l.id);
      companyBuckets.set(key, arr);
    }
    const { key, viaAlias } = nameKeyFor(l.name, nameAliases);
    if (viaAlias) viaAliasIds.add(l.id);
    if (key) {
      const nk = `${scope}::n:${key}`;
      const arr = nameBuckets.get(nk) ?? [];
      arr.push(l.id);
      nameBuckets.set(nk, arr);
    }
  }

  for (const ids of companyBuckets.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) companyJoinedIds.add(id);
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  }
  for (const ids of nameBuckets.values()) {
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  }

  const byId = new Map(labels.map((l) => [l.id, l]));
  const components = new Map<string, L[]>();
  for (const l of labels) {
    const root = find(l.id);
    const arr = components.get(root) ?? [];
    arr.push(byId.get(l.id)!);
    components.set(root, arr);
  }

  return [...components.values()]
    .filter((c) => c.length >= 2)
    .map((c) => {
      const reason: LabelCluster<L>["reason"] = c.some((l) => companyJoinedIds.has(l.id))
        ? "company"
        : c.some((l) => viaAliasIds.has(l.id))
          ? "alias"
          : "name";
      return { labels: c, reason };
    });
}

export const CLUSTER_RATIONALE: Record<LabelCluster<LabelClusterInput>["reason"], string> = {
  company: "These labels' contacts all belong to the same company.",
  alias: "Includes a merged-away company name variant.",
  name: "Same normalized name within the same parent label.",
};

/** Canonical pick: most members, then non-auto rows over auto-generated,
 *  then shortest name (usually the umbrella brand). Returns the cluster
 *  sorted with the canonical first. */
export function sortCanonicalFirst<L extends LabelClusterInput>(cluster: L[]): L[] {
  return [...cluster].sort((a, b) => {
    if (b.member_count !== a.member_count) return b.member_count - a.member_count;
    const aAuto = a.auto_generated_from_group_id ? 1 : 0;
    const bAuto = b.auto_generated_from_group_id ? 1 : 0;
    if (aAuto !== bAuto) return aAuto - bAuto;
    return a.name.length - b.name.length;
  });
}

/** Dominant company per label: the most common non-null member company,
 *  required to cover a strict majority of the label's members so mixed
 *  labels never company-cluster. */
export function dominantCompany(
  memberContactIds: string[],
  companyByContact: Map<string, string | null>,
): string | null {
  if (memberContactIds.length === 0) return null;
  const counts = new Map<string, number>();
  for (const cid of memberContactIds) {
    const company = companyByContact.get(cid);
    if (!company) continue;
    counts.set(company, (counts.get(company) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [company, n] of counts) {
    if (n > bestN) {
      best = company;
      bestN = n;
    }
  }
  return best && bestN * 2 > memberContactIds.length ? best : null;
}
