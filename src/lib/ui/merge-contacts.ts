/**
 * Field precedence for the manual contact merge.
 *
 * Two pure steps used by `MergeContactsDialog`: seeding the dialog's initial
 * selection from the merge payload, and turning the user's final selection
 * into the request body. Both were inline in the component, where the rules
 * that decide which contact's value survives a merge — a destructive,
 * irreversible operation — could not be tested.
 */

/** Scalar contact columns the user can pick a source for, in display order. */
export const SCALAR_FIELDS: Array<{ key: string; label: string }> = [
  { key: "name", label: "Name" },
  { key: "email", label: "Primary email" },
  { key: "title", label: "Title" },
  { key: "company", label: "Company (text)" },
  { key: "company_id", label: "Company (linked)" },
  { key: "avatar_url", label: "Photo" },
  { key: "website", label: "Website" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "twitter", label: "Twitter" },
  { key: "city", label: "City" },
  { key: "region", label: "Region" },
  { key: "postal_code", label: "Postal code" },
  { key: "country", label: "Country" },
];

export type MergeContactLike = { id: string; notes?: string | null };
export type MergeEmailLike = {
  id: string;
  contact_id: string;
  label: string;
  address: string;
  is_primary: boolean;
};
export type MergePhoneLike = {
  id: string;
  contact_id: string;
  label: string;
  number: string;
  is_primary: boolean;
};

export type MergePayload<C extends MergeContactLike> = {
  contacts: C[];
  emails: MergeEmailLike[];
  phones: MergePhoneLike[];
  memberships: { group_id: string }[];
};

/** The dialog's whole selection state, as one value. */
export type MergeSelection = {
  primaryId: string | null;
  /** field key -> id of the contact whose value wins. */
  fieldChoice: Record<string, string>;
  notesSource: string | null;
  keepEmails: Set<string>;
  keepPhones: Set<string>;
  primaryEmail: string | null;
  primaryPhone: string | null;
  excludedGroups: Set<string>;
};

/** The body sent to `mergeContactsManual`. */
export type MergeRequest = {
  primaryId: string;
  loserIds: string[];
  fields: Record<string, string | null>;
  notesSource: string | null;
  emails: Array<{ label: string; address: string; is_primary: boolean }>;
  phones: Array<{ label: string; number: string; is_primary: boolean }>;
  excludedGroupIds: string[];
  manualLockFields: string[];
};

/** Read a dynamic scalar column off a contact row. */
function fieldValue(contact: MergeContactLike, key: string): unknown {
  return (contact as unknown as Record<string, unknown>)[key];
}

/** A scalar counts as present only when it is non-null and not the empty string. */
function hasValue(contact: MergeContactLike, key: string): boolean {
  const v = fieldValue(contact, key);
  return v != null && String(v).length > 0;
}

/**
 * The dialog's opening selection for a freshly loaded payload.
 *
 * Field precedence, per scalar column: the primary contact's value if it has
 * one, otherwise the first contact in payload order that does. A column no
 * contact fills gets no entry at all, which is what leaves it out of
 * `manualLockFields` later.
 *
 * Notes are handled separately from the scalars because they are decrypted
 * per contact: prefer the primary's notes, else the first contact that has
 * any, else fall back to the primary (so the field is never unassigned).
 *
 * Every email and phone is kept by default — a merge should not silently
 * drop a contact method — with the primary of each chosen from the survivor
 * where possible.
 *
 * `preferredPrimaryId` is the user's existing pick when the payload reloads;
 * pass null to default to the first contact.
 */
export function seedMergeSelection<C extends MergeContactLike>(
  payload: MergePayload<C>,
  preferredPrimaryId: string | null = null,
): MergeSelection | null {
  const first = payload.contacts[0];
  if (!first) return null;
  const primaryId = preferredPrimaryId ?? first.id;
  const primary = payload.contacts.find((c) => c.id === primaryId);

  const fieldChoice: Record<string, string> = {};
  for (const f of SCALAR_FIELDS) {
    if (primary && hasValue(primary, f.key)) {
      fieldChoice[f.key] = primaryId;
      continue;
    }
    const other = payload.contacts.find((c) => hasValue(c, f.key));
    if (other) fieldChoice[f.key] = other.id;
  }

  const withNotes =
    payload.contacts.find((c) => c.id === primaryId && c.notes) ??
    payload.contacts.find((c) => c.notes);

  const primaryEmail =
    payload.emails.find((e) => e.contact_id === primaryId && e.is_primary) ??
    payload.emails.find((e) => e.contact_id === primaryId) ??
    payload.emails[0];
  const primaryPhone =
    payload.phones.find((p) => p.contact_id === primaryId && p.is_primary) ??
    payload.phones.find((p) => p.contact_id === primaryId) ??
    payload.phones[0];

  return {
    primaryId,
    fieldChoice,
    notesSource: withNotes?.id ?? primaryId,
    keepEmails: new Set(payload.emails.map((e) => e.id)),
    keepPhones: new Set(payload.phones.map((p) => p.id)),
    primaryEmail: primaryEmail?.id ?? null,
    primaryPhone: primaryPhone?.id ?? null,
    excludedGroups: new Set(),
  };
}

/**
 * Turn the final selection into the merge request.
 *
 * Every field the user chose a source for is sent, `null` included, so an
 * explicit "take the empty one" is honoured. `manualLockFields` names only
 * the fields that ended up with a real value — those are locked against
 * later enrichment, and locking a field to nothing would be meaningless.
 *
 * Throws when there is no survivor selected; the dialog's Merge button is
 * disabled in that state, so reaching here means something upstream broke.
 */
export function buildMergeRequest<C extends MergeContactLike>(
  payload: MergePayload<C>,
  selection: MergeSelection,
): MergeRequest {
  const { primaryId } = selection;
  if (!primaryId) throw new Error("No primary selected");

  const fields: Record<string, string | null> = {};
  for (const [fieldKey, sourceId] of Object.entries(selection.fieldChoice)) {
    const src = payload.contacts.find((c) => c.id === sourceId);
    fields[fieldKey] =
      (src ? (fieldValue(src, fieldKey) as string | null | undefined) : null) ?? null;
  }

  return {
    primaryId,
    loserIds: payload.contacts.filter((c) => c.id !== primaryId).map((c) => c.id),
    fields,
    notesSource: selection.notesSource,
    emails: payload.emails
      .filter((e) => selection.keepEmails.has(e.id))
      .map((e) => ({
        label: e.label,
        address: e.address,
        is_primary: e.id === selection.primaryEmail,
      })),
    phones: payload.phones
      .filter((p) => selection.keepPhones.has(p.id))
      .map((p) => ({
        label: p.label,
        number: p.number,
        is_primary: p.id === selection.primaryPhone,
      })),
    excludedGroupIds: Array.from(selection.excludedGroups),
    manualLockFields: Object.keys(fields).filter(
      (k) => selection.fieldChoice[k] && fields[k] != null && String(fields[k]).length > 0,
    ),
  };
}

/** Distinct group ids across every contact being merged, in first-seen order. */
export function unionGroupIds(memberships: { group_id: string }[]): string[] {
  return Array.from(new Set(memberships.map((m) => m.group_id)));
}
