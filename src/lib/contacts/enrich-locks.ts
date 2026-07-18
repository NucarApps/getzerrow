// Pure helpers for enrichment lock semantics. Kept free of Supabase / Gmail
// / AI SDK imports so the unit tests can exercise the "never overwrite a
// manually edited field" invariant without spinning up the whole server
// stack.

export const ENRICHABLE_SCALAR_FIELDS = [
  "name",
  "title",
  "company",
  "phone",
  "website",
  "linkedin",
  "twitter",
  "address_line1",
  "address_line2",
  "city",
  "region",
  "postal_code",
  "country",
] as const;

export type EnrichableField = (typeof ENRICHABLE_SCALAR_FIELDS)[number];

/** Fields the user has locked in — enrichment must never overwrite them. */
export function buildLockedFieldSet(contact: {
  manual_overrides?: string[] | null;
  company_id?: string | null;
}): Set<string> {
  const locked = new Set<string>(contact.manual_overrides ?? []);
  // Explicitly linking a company via the combobox is an unambiguous user
  // action, so treat the company text as locked even without an override.
  if (contact.company_id) locked.add("company");
  return locked;
}

type ContactShape = {
  name?: string | null;
  title?: string | null;
  company?: string | null;
  phone?: string | null;
  website?: string | null;
  linkedin?: string | null;
  twitter?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
  manual_overrides?: string[] | null;
  company_id?: string | null;
};

type Extracted = Partial<Record<EnrichableField, string | null | undefined>>;

type PickBetterName = (
  existing: string | null | undefined,
  candidate: string | null | undefined,
) => string | null;

export type EnrichmentFieldPatch = Partial<Record<EnrichableField, string>>;

/** Compute the plaintext-field patch produced by an enrichment pass.
 *
 * Rules — locked in by tests, changing them requires updating the tests:
 * - Any field named in `locked` is skipped entirely.
 * - For "name", we run pickBetterName across (current, fromNameCandidate,
 *   extracted.name) but never emit an unchanged value.
 * - For every other scalar, we only write when the extracted value is
 *   truthy AND (the current value is empty OR `force` is true).
 */
export function computeEnrichmentFieldPatch(args: {
  contact: ContactShape;
  extracted: Extracted;
  fromNameCandidate: string | null | undefined;
  force: boolean;
  pickBetterName: PickBetterName;
}): EnrichmentFieldPatch {
  const { contact, extracted, fromNameCandidate, force, pickBetterName } = args;
  const locked = buildLockedFieldSet(contact);
  const patch: EnrichmentFieldPatch = {};

  for (const k of ENRICHABLE_SCALAR_FIELDS) {
    if (locked.has(k)) continue;
    const v = extracted[k];
    if (k === "name") {
      let best = pickBetterName(contact.name, fromNameCandidate);
      best = pickBetterName(best, v);
      if (best && best !== contact.name) patch.name = best;
      continue;
    }
    const current = contact[k] ?? null;
    if (v && (!current || force)) patch[k] = v;
  }
  return patch;
}
