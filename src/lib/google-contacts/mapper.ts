// Pure mapping between Zerrow's internal contact shape and Google People API
// `Person` resources. No I/O, no Supabase — safe to unit test in isolation.

import { buildMergedNote, stripSummaryFromNote } from "@/lib/carddav/vcard";


export type PersonName = {
  givenName?: string;
  familyName?: string;
  middleName?: string;
  displayName?: string;
};

export type PersonEmail = { value?: string; type?: string; metadata?: { primary?: boolean } };

export type PersonPhone = { value?: string; type?: string; metadata?: { primary?: boolean } };

export type PersonAddress = {
  streetAddress?: string;
  extendedAddress?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  formattedType?: string;
  type?: string;
};

export type PersonMembership = { contactGroupMembership?: { contactGroupResourceName?: string } };

export type PersonPhoto = { url?: string; default?: boolean; metadata?: { primary?: boolean } };

export type Person = {
  resourceName?: string;
  etag?: string;
  metadata?: {
    deleted?: boolean;
    sources?: Array<{ updateTime?: string; type?: string; id?: string }>;
  };
  names?: PersonName[];
  emailAddresses?: PersonEmail[];
  phoneNumbers?: PersonPhone[];
  organizations?: Array<{ name?: string; title?: string }>;
  biographies?: Array<{ value?: string; contentType?: string }>;
  addresses?: PersonAddress[];
  urls?: Array<{ value?: string; type?: string }>;
  memberships?: PersonMembership[];
  photos?: PersonPhoto[];
};

/** Local Zerrow contact projection used by the sync layer. */
export type LocalContact = {
  id: string;
  email: string | null;
  name: string | null;
  title: string | null;
  company: string | null;
  website: string | null;
  linkedin: string | null;
  twitter: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  notes: string | null;
  relationship_summary?: string | null;
  primary_phone: string | null;
};


export type LocalPhone = { label: string; number: string; is_primary: boolean };

export type LocalEmail = { label: string; address: string; is_primary: boolean };


/** Split a display name into given/family. Best-effort — Google is forgiving. */
export function splitName(name: string | null): PersonName | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { givenName: parts[0], displayName: trimmed };
  return {
    givenName: parts[0],
    familyName: parts.slice(1).join(" "),
    displayName: trimmed,
  };
}

/** Recombine Google's Name fields into a single display name. */
export function joinName(name: PersonName | undefined): string | null {
  if (!name) return null;
  const display = name.displayName?.trim();
  if (display) return display;
  const parts = [name.givenName, name.middleName, name.familyName].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  return parts.length ? parts.join(" ") : null;
}

/**
 * Build a People API Person payload from a Zerrow contact plus its phones and
 * group memberships. Only fields we manage are included — leaves everything
 * else on Google's side untouched.
 */
export function contactToPerson(
  contact: LocalContact,
  phones: LocalPhone[],
  memberships: string[], // Google contactGroups/xxx resource names
  primaryEmailPrevious?: boolean,
  emails: LocalEmail[] = [],
  options: { includeSummary?: boolean } = {},
): Partial<Person> {

  const person: Partial<Person> = {};

  const nm = splitName(contact.name);
  if (nm) person.names = [nm];

  // Emit every email row. Fall back to the single contact.email column when
  // the caller didn't provide the multi-email list (keeps older tests working).
  const emailList: LocalEmail[] = emails.length
    ? emails
    : contact.email?.trim()
      ? [{ label: "work", address: contact.email.trim(), is_primary: primaryEmailPrevious !== false }]
      : [];
  if (emailList.length) {
    const seen = new Set<string>();
    const rows: PersonEmail[] = [];
    for (const em of emailList) {
      const v = em.address.trim().toLowerCase();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      rows.push({ value: em.address.trim(), type: em.label || "other", metadata: { primary: em.is_primary } });
    }
    if (rows.length && !rows.some((r) => r.metadata?.primary)) {
      rows[0] = { ...rows[0], metadata: { primary: true } };
    }
    if (rows.length) person.emailAddresses = rows;
  }


  const phoneList: PersonPhone[] = [];
  const seen = new Set<string>();
  const pushPhone = (num: string | null, label: string, primary: boolean) => {
    const v = (num ?? "").trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    phoneList.push({ value: v, type: label || "other", metadata: { primary } });
  };
  if (phones.length) {
    const primary = phones.find((p) => p.is_primary) ?? phones[0];
    for (const p of phones) pushPhone(p.number, p.label || "other", p === primary);
  } else if (contact.primary_phone) {
    pushPhone(contact.primary_phone, "mobile", true);
  }
  if (phoneList.length) person.phoneNumbers = phoneList;

  if (contact.company || contact.title) {
    person.organizations = [
      { name: contact.company ?? undefined, title: contact.title ?? undefined },
    ];
  }

  const mergedNote = buildMergedNote(
    options.includeSummary !== false ? contact.relationship_summary ?? null : null,
    contact.notes,
  );
  if (mergedNote) {
    person.biographies = [{ value: mergedNote, contentType: "TEXT_PLAIN" }];
  }


  const addrLine =
    [contact.address_line1, contact.address_line2].filter(Boolean).join(", ").trim() || undefined;
  if (
    addrLine ||
    contact.city ||
    contact.region ||
    contact.postal_code ||
    contact.country
  ) {
    person.addresses = [
      {
        streetAddress: addrLine,
        city: contact.city ?? undefined,
        region: contact.region ?? undefined,
        postalCode: contact.postal_code ?? undefined,
        country: contact.country ?? undefined,
        type: "work",
      },
    ];
  }

  const urls: Array<{ value: string; type: string }> = [];
  if (contact.website) urls.push({ value: contact.website, type: "homepage" });
  if (contact.linkedin) urls.push({ value: contact.linkedin, type: "LinkedIn" });
  if (contact.twitter) urls.push({ value: contact.twitter, type: "Twitter" });
  if (urls.length) person.urls = urls;

  if (memberships.length) {
    person.memberships = memberships.map((rn) => ({
      contactGroupMembership: { contactGroupResourceName: rn },
    }));
  }

  return person;
}

/**
 * `updatePersonFields` string listing exactly the fields our writer manages.
 * Google requires this on every `updateContact` call and treats missing fields
 * as "no change" — safe to always send the full set.
 */
export const UPDATE_PERSON_FIELDS =
  "names,emailAddresses,phoneNumbers,organizations,biographies,addresses,urls,memberships";

/** `personFields` mask for reads (connections.list, batchGet, createContact). */
export const READ_PERSON_FIELDS =
  "names,emailAddresses,phoneNumbers,organizations,biographies,addresses,urls,memberships,photos,metadata";

/** Parse Google's Person into the writable subset of a Zerrow contact. */
export function personToContact(person: Person): {
  email: string | null;
  emails: LocalEmail[];
  patch: Partial<LocalContact>;
  phones: LocalPhone[];
  membershipResourceNames: string[];
  updateTime: string | null;
  /** URL to Google's copy of the contact photo (short-lived signed URL from
   * the People API). Present only when the user has actually attached a
   * picture — Google auto-generates a "silhouette" default that we skip. */
  photoUrl: string | null;
} {
  const rawEmails = person.emailAddresses ?? [];
  const primaryEmailIdx = rawEmails.findIndex((e) => e.metadata?.primary && e.value);
  const primaryEmail =
    (primaryEmailIdx >= 0 ? rawEmails[primaryEmailIdx].value : null) ??
    rawEmails.find((e) => e.value)?.value ??
    null;

  const seenEmail = new Set<string>();
  const emails: LocalEmail[] = [];
  for (const e of rawEmails) {
    const v = e.value?.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seenEmail.has(key)) continue;
    seenEmail.add(key);
    emails.push({
      label: (e.type ?? "other").toLowerCase(),
      address: v,
      is_primary: !!e.metadata?.primary,
    });
  }
  if (emails.length && !emails.some((e) => e.is_primary)) {
    emails[0] = { ...emails[0], is_primary: true };
  }


  const patch: Partial<LocalContact> = {
    name: joinName(person.names?.[0]),
    company: person.organizations?.[0]?.name?.trim() || null,
    title: person.organizations?.[0]?.title?.trim() || null,
    notes: person.biographies?.[0]?.value?.trim() || null,
  };

  const addr = person.addresses?.[0];
  if (addr) {
    patch.address_line1 = addr.streetAddress?.trim() || null;
    patch.address_line2 = addr.extendedAddress?.trim() || null;
    patch.city = addr.city?.trim() || null;
    patch.region = addr.region?.trim() || null;
    patch.postal_code = addr.postalCode?.trim() || null;
    patch.country = addr.country?.trim() || null;
  }

  const website = person.urls?.find((u) => (u.type ?? "").toLowerCase() === "homepage")?.value;
  const linkedin = person.urls?.find((u) => (u.type ?? "").toLowerCase() === "linkedin")?.value;
  const twitter = person.urls?.find((u) => (u.type ?? "").toLowerCase() === "twitter")?.value;
  if (website !== undefined) patch.website = website || null;
  if (linkedin !== undefined) patch.linkedin = linkedin || null;
  if (twitter !== undefined) patch.twitter = twitter || null;

  const phoneRaw = person.phoneNumbers ?? [];
  const primary = phoneRaw.find((p) => p.metadata?.primary && p.value) ?? phoneRaw[0];
  const phones: LocalPhone[] = phoneRaw
    .filter((p): p is PersonPhone & { value: string } => typeof p.value === "string" && !!p.value)
    .map((p) => ({
      label: (p.type ?? "other").toLowerCase(),
      number: p.value,
      is_primary: p === primary,
    }));
  patch.primary_phone = primary?.value?.trim() || null;

  const membershipResourceNames = (person.memberships ?? [])
    .map((m) => m.contactGroupMembership?.contactGroupResourceName)
    .filter((n): n is string => !!n && n.startsWith("contactGroups/"));

  const updateTime = person.metadata?.sources?.[0]?.updateTime ?? null;

  // Prefer the primary photo (Google marks the user-uploaded one); fall
  // back to the first non-default entry so we still pick up photos on
  // People API rows that omit the primary flag.
  const photoRow =
    (person.photos ?? []).find((p) => p.metadata?.primary && p.url && !p.default) ??
    (person.photos ?? []).find((p) => p.url && !p.default) ??
    null;
  const photoUrl = photoRow?.url ?? null;

  return { email: primaryEmail, emails, patch, phones, membershipResourceNames, updateTime, photoUrl };
}

/** Zerrow group → Google contactGroups payload. */
export function groupToLabel(name: string): { contactGroup: { name: string } } {
  return { contactGroup: { name: name.trim() } };
}

/** Google contactGroup → Zerrow group name (system groups have formatted names). */
export function labelToGroupName(g: {
  name?: string;
  formattedName?: string;
  groupType?: string;
}): string | null {
  if (g.groupType && g.groupType !== "USER_CONTACT_GROUP") return null;
  return (g.name || g.formattedName || "").trim() || null;
}
