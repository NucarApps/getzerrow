// Filtering and multi-selection for the contacts list, lifted out of
// `routes/_authenticated/contacts.index.tsx`.
//
// The group filter and the search box compose — a group with a search term in
// it means "people in this group whose name/email/company matches" — and the
// group filter follows the group tree downwards, so picking a parent shows the
// children's members too. Getting either wrong hides people who exist.

/** The fields the list filter reads off a contact. */
export type FilterableContact = {
  id: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
};

/** "all", "ungrouped", or a group id. */
export type ContactFilter = string;

/**
 * Which group ids a filter admits.
 *
 * A group filter admits the group AND everything under it, so selecting a
 * parent in the rail shows the whole subtree. `null` means the filter does not
 * constrain by group at all. The `?? new Set([filter])` fallback covers a
 * group id the descendant index has not caught up with — filtering to just
 * that group beats filtering to nothing.
 */
export function allowedGroupIdsFor(
  filter: ContactFilter,
  descendantsById: ReadonlyMap<string, Set<string>>,
): ReadonlySet<string> | null {
  if (filter === "all" || filter === "ungrouped") return null;
  return descendantsById.get(filter) ?? new Set([filter]);
}

/** Case-insensitive substring match over name, email and company. */
export function matchesContactQuery(contact: FilterableContact, lowercasedTerm: string): boolean {
  if (!lowercasedTerm) return true;
  return (
    (contact.name ?? "").toLowerCase().includes(lowercasedTerm) ||
    (contact.email ?? "").toLowerCase().includes(lowercasedTerm) ||
    (contact.company ?? "").toLowerCase().includes(lowercasedTerm)
  );
}

/**
 * The visible contact list: the group filter first, then the search term.
 *
 * Order within the input is preserved — the server already sorted it, and
 * re-sorting here would make the list jump as the user types.
 */
export function filterContacts<T extends FilterableContact>({
  contacts,
  query,
  filter,
  contactGroupMap,
  descendantsById,
}: {
  contacts: readonly T[];
  query: string;
  filter: ContactFilter;
  contactGroupMap: ReadonlyMap<string, string[]>;
  descendantsById: ReadonlyMap<string, Set<string>>;
}): T[] {
  const term = query.toLowerCase().trim();
  const allowedGroupIds = allowedGroupIdsFor(filter, descendantsById);
  return contacts.filter((x) => {
    if (filter === "ungrouped" && (contactGroupMap.get(x.id)?.length ?? 0) > 0) return false;
    if (allowedGroupIds) {
      const gids = contactGroupMap.get(x.id) ?? [];
      if (!gids.some((gid) => allowedGroupIds.has(gid))) return false;
    }
    return matchesContactQuery(x, term);
  });
}

/** contact id -> the group ids it belongs to. */
export function buildContactGroupMap(
  memberships: readonly { contact_id: string; group_id: string }[],
): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const x of memberships) {
    const arr = m.get(x.contact_id) ?? [];
    arr.push(x.group_id);
    m.set(x.contact_id, arr);
  }
  return m;
}

/** How many contacts belong to no group — the count on the "Ungrouped" rail row. */
export function countUngrouped(
  contacts: readonly { id: string }[],
  contactGroupMap: ReadonlyMap<string, string[]>,
): number {
  let n = 0;
  for (const c of contacts) if ((contactGroupMap.get(c.id)?.length ?? 0) === 0) n++;
  return n;
}

/** Add or remove one id, returning a new set. */
export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * The section checkbox: select the whole section, or clear it if every member
 * is already selected.
 *
 * "Every member" is judged against the ids passed in, not against the whole
 * selection, so ticking one section never disturbs another. An empty section
 * is a no-op rather than a clear — `[].every(...)` is true, and without the
 * length guard an empty section's checkbox would read as "all selected".
 */
export function toggleIds(selected: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const next = new Set(selected);
  const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
  for (const id of ids) {
    if (allSelected) next.delete(id);
    else next.add(id);
  }
  return next;
}

/**
 * True when every company section is collapsed, which flips the toolbar button
 * from Collapse all to Expand all. With no sections at all the button reads as
 * Collapse all — there is nothing to expand.
 */
export function allBucketsCollapsed(
  buckets: readonly { key: string }[],
  collapsed: ReadonlySet<string>,
): boolean {
  return buckets.length > 0 && buckets.every((b) => collapsed.has(b.key));
}

/** What the Expand-all / Collapse-all button does next. */
export function toggleAllBuckets(
  buckets: readonly { key: string }[],
  collapsed: ReadonlySet<string>,
): Set<string> {
  if (allBucketsCollapsed(buckets, collapsed)) return new Set();
  return new Set(buckets.map((b) => b.key));
}

/**
 * First display letter for a contact's monogram avatar.
 *
 * The trailing `|| "?"` catches a name that is present but yields no first
 * character — a leading space is trimmed away, but a name of only whitespace
 * trims to nothing at all.
 */
export function contactInitial(contact: { name?: string | null; email?: string | null }): string {
  return (contact.name || contact.email || "?").trim().charAt(0).toUpperCase() || "?";
}
