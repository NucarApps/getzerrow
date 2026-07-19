/**
 * Pure helpers for the contact-group (label) tree. Shared by the contacts
 * sidebar, the Labels manager page, and the group editor's parent picker.
 * Server-side validation in contact-groups.functions.ts remains the
 * authority; `eligibleParents` mirrors its rules so the UI simply doesn't
 * offer invalid choices.
 */

export const MAX_GROUP_DEPTH = 4;

export type GroupTreeNode = {
  id: string;
  name: string;
  parent_group_id?: string | null;
};

/** Pre-order walk with per-group depth for indented tree rendering.
 *  Siblings are sorted by name. */
export function buildGroupTree<G extends GroupTreeNode>(
  groups: G[],
): { group: G; depth: number }[] {
  const children = new Map<string | null, G[]>();
  for (const g of groups) {
    const key = g.parent_group_id ?? null;
    const arr = children.get(key) ?? [];
    arr.push(g);
    children.set(key, arr);
  }
  for (const arr of children.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
  const out: { group: G; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const g of children.get(parent) ?? []) {
      if (seen.has(g.id)) continue; // cycle guard on malformed data
      seen.add(g.id);
      out.push({ group: g, depth });
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** groupId -> Set of descendant group ids (including itself). */
export function buildDescendantsById<G extends GroupTreeNode>(
  groups: G[],
): Map<string, Set<string>> {
  const kids = new Map<string, string[]>();
  for (const g of groups) {
    if (!g.parent_group_id) continue;
    const arr = kids.get(g.parent_group_id) ?? [];
    arr.push(g.id);
    kids.set(g.parent_group_id, arr);
  }
  const out = new Map<string, Set<string>>();
  for (const g of groups) {
    const set = new Set<string>([g.id]);
    const stack = [g.id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const c of kids.get(cur) ?? []) {
        if (!set.has(c)) {
          set.add(c);
          stack.push(c);
        }
      }
    }
    out.set(g.id, set);
  }
  return out;
}

/** Depth of the parent chain rooted at `startId` (1 = no parent). Bounded
 *  like the server's chainDepth so malformed data can't loop forever. */
function chainDepth(parents: Map<string, string | null>, startId: string): number {
  let cursor: string | null = startId;
  let depth = 0;
  while (cursor && depth < 32) {
    depth++;
    cursor = parents.get(cursor) ?? null;
  }
  return depth;
}

/** Groups that may become the parent of `groupId` (null = creating a new
 *  group): excludes the group itself and its descendants (cycles) and any
 *  parent already at the max nesting depth — the same rules the server
 *  enforces in create/updateContactGroup. */
export function eligibleParents<G extends GroupTreeNode>(
  groups: G[],
  groupId: string | null,
  maxDepth: number = MAX_GROUP_DEPTH,
): G[] {
  const parents = new Map<string, string | null>();
  for (const g of groups) parents.set(g.id, g.parent_group_id ?? null);
  const excluded = groupId
    ? (buildDescendantsById(groups).get(groupId) ?? new Set([groupId]))
    : new Set<string>();
  return groups.filter((g) => !excluded.has(g.id) && chainDepth(parents, g.id) + 1 <= maxDepth);
}
