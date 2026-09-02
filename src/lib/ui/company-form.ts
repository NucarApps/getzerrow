// The company detail page's pure decisions, lifted out of
// `routes/_authenticated/contacts.companies.$companyId.tsx`.
//
// The one that matters most is `companyUpdatePayload`: the writer treats
// `undefined` as "leave this column alone" and `null` as "clear it", so which
// one an empty text box turns into decides whether clearing a field works at
// all — and, for the name, whether an empty box wipes the company's name.

/** Every editable text field on the company form. */
export type CompanyForm = {
  name: string;
  website: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  industry: string;
  description: string;
};

/** The nullable shape those fields have in the database. */
export type CompanyRow = Partial<Record<keyof CompanyForm, string | null>>;

export const EMPTY_COMPANY_FORM: CompanyForm = {
  name: "",
  website: "",
  phone: "",
  address_line1: "",
  address_line2: "",
  city: "",
  region: "",
  postal_code: "",
  country: "",
  industry: "",
  description: "",
};

const FORM_FIELDS = Object.keys(EMPTY_COMPANY_FORM) as (keyof CompanyForm)[];

/**
 * Seed the form from the loaded row. A null column becomes an empty box —
 * a controlled input handed `null` would switch to uncontrolled and React
 * would warn on the first keystroke.
 */
export function companyFormFromRow(company: CompanyRow | null | undefined): CompanyForm {
  const form = { ...EMPTY_COMPANY_FORM };
  if (!company) return form;
  for (const field of FORM_FIELDS) form[field] = company[field] ?? "";
  return form;
}

export type CompanyUpdatePayload = { id: string } & {
  name?: string | undefined;
} & Partial<Record<Exclude<keyof CompanyForm, "name">, string | null>>;

/**
 * The payload the update writer takes.
 *
 * Every field except the name maps an empty box to `null`, which the writer
 * reads as CLEAR — that is what makes deleting a phone number stick rather
 * than silently reverting on the next load.
 *
 * The name is the deliberate exception: it maps to `undefined`, meaning LEAVE
 * ALONE. A company must always have a name, and an accidentally-cleared box
 * saved as `null` would leave an unnamed row that no list view could label.
 */
export function companyUpdatePayload(id: string, form: CompanyForm): CompanyUpdatePayload {
  return {
    id,
    name: form.name || undefined,
    website: form.website || null,
    phone: form.phone || null,
    address_line1: form.address_line1 || null,
    address_line2: form.address_line2 || null,
    city: form.city || null,
    region: form.region || null,
    postal_code: form.postal_code || null,
    country: form.country || null,
    industry: form.industry || null,
    description: form.description || null,
  };
}

/**
 * Report what a domain-discovery run turned up. "Refreshed" and "new" are
 * separate counts because a refresh with nothing new still did work, and
 * reporting it as "No new domains found" would read as a failed run.
 */
export function discoverDomainsSummary(result: { added?: number; updated?: number }): string {
  const parts: string[] = [];
  if (result.added) parts.push(`${result.added} new`);
  if (result.updated) parts.push(`${result.updated} refreshed`);
  return parts.length ? `Discovered domains: ${parts.join(", ")}` : "No new domains found";
}

/**
 * Companies this one can be merged into. The company itself is excluded —
 * merging a company into itself would delete it as the "source" side.
 */
export function mergeCandidates<T extends { id: string }>(
  companies: readonly T[],
  currentId: string,
): T[] {
  return companies.filter((c) => c.id !== currentId);
}

/**
 * The domain the logo and header are keyed off: the first one on the company.
 * Ordering is the server's, so this is "the preferred domain", not "any".
 */
export function primaryDomainOf(
  domains: readonly { domain: string | null }[] | null | undefined,
): string | null {
  return domains?.[0]?.domain ?? null;
}

export type LogoChoice = { provider: number | null; sourceDomain: string | null };

/**
 * The user's stored logo choice for this company's primary domain, if any.
 *
 * Both halves come from the same row or neither does: a provider taken from
 * one domain's choice and a source domain from another's would ask the proxy
 * for a logo that does not exist.
 */
export function logoChoiceFor(
  primaryDomain: string | null,
  choices:
    readonly { domain: string; provider: number; source_domain: string | null }[] | undefined,
): LogoChoice {
  if (!primaryDomain || !choices) return { provider: null, sourceDomain: null };
  const choice = choices.find((c) => c.domain === primaryDomain);
  if (!choice) return { provider: null, sourceDomain: null };
  return { provider: choice.provider, sourceDomain: choice.source_domain };
}

/** How contact photos are chosen for people at this company. */
export type PhotoPriority = "company_first" | "personal_first" | "personal_only";

export type PhotoPriorityDisplay = {
  /** The company's own setting, or null when it has none. */
  override: PhotoPriority | null;
  /** What actually applies, after the fallback. */
  effective: PhotoPriority;
  /** Whether the effective value comes from this company or the app default. */
  source: "company" | "default";
};

/**
 * Resolve the photo-priority control's three values from the one nullable
 * column. `source` has to be derived from the override rather than from
 * whether `effective` equals the default, or a company that explicitly picked
 * "company_first" would be shown as merely inheriting it.
 */
export function photoPriorityDisplay(
  override: PhotoPriority | null | undefined,
): PhotoPriorityDisplay {
  if (!override) return { override: null, effective: "company_first", source: "default" };
  return { override, effective: override, source: "company" };
}

/**
 * The tag list after the Enter key, or null when there is nothing to add.
 *
 * Tags are lower-cased so "Vendor" and "vendor" are the same tag. Duplicates
 * are not filtered here — the writer collapses them (`Array.from(new Set(…))`)
 * and the refetch brings back the collapsed list.
 */
export function tagsAfterAdd(tags: readonly string[], input: string): string[] | null {
  const value = input.trim();
  if (!value) return null;
  return [...tags, value.toLowerCase()];
}

/** The tag list after removing one. Removes every copy, if somehow there are two. */
export function tagsAfterRemove(tags: readonly string[], tag: string): string[] {
  return tags.filter((x) => x !== tag);
}
