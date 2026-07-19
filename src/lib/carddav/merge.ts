import type { ParsedVCard } from "./vcard";

export type ExistingCardDavContact = {
  email: string | null;
  source: string | null;
};

export type CardDavContactPatch = {
  user_id: string;
  source: string;
  updated_at: string;
  email?: string | null;
  name?: string | null;
  company?: string | null;
  /** Resolved Company entity — set by the PUT handler when ORG is present. */
  company_id?: string | null;
  title?: string | null;
  website?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
  linkedin?: string | null;
  twitter?: string | null;
};

export type EmailMergeDecision =
  | "missing_new_contact"
  | "missing_existing_contact"
  | "blank_new_contact"
  | "blank_preserved_existing"
  | "accepted_value";

export type CardDavContactMerge = {
  patch: CardDavContactPatch;
  emailDecision: EmailMergeDecision;
  preservedEmailOverBlank: boolean;
};

function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function isLegacyPlaceholderEmail(value: string): boolean {
  return /^carddav\+[0-9a-f-]+@local\.zerrow$/i.test(value);
}

/**
 * Build the plaintext contact patch for a CardDAV PUT. This is intentionally
 * conservative: iOS can send follow-up partial cards that omit or blank EMAIL,
 * and those must never undo an email that was just saved on the server.
 */
export function buildCardDavContactPatch(input: {
  userId: string;
  existing: ExistingCardDavContact | null;
  parsed: ParsedVCard;
  nowIso: string;
}): CardDavContactMerge {
  const { userId, existing, parsed, nowIso } = input;
  const present = parsed.presentFields;
  const patch: CardDavContactPatch = {
    user_id: userId,
    source: existing?.source ?? "carddav",
    updated_at: nowIso,
  };

  let emailDecision: EmailMergeDecision = existing
    ? "missing_existing_contact"
    : "missing_new_contact";
  let preservedEmailOverBlank = false;

  if (present.has("EMAIL")) {
    const incomingEmail = normalizeEmail(parsed.email);
    if (incomingEmail && !isLegacyPlaceholderEmail(incomingEmail)) {
      patch.email = incomingEmail;
      emailDecision = "accepted_value";
    } else if (existing?.email) {
      // Defensive guard for clients that include EMAIL as a blank slot. The
      // parser should already omit blank EMAIL from presentFields, but this
      // keeps the merge safe if another client shape slips through.
      emailDecision = "blank_preserved_existing";
      preservedEmailOverBlank = true;
    } else {
      patch.email = null;
      emailDecision = "blank_new_contact";
    }
  } else if (!existing) {
    patch.email = null;
  }

  if (present.has("FN")) patch.name = parsed.name;
  if (present.has("ORG")) patch.company = parsed.company;
  if (present.has("TITLE")) patch.title = parsed.title;
  if (present.has("URL")) patch.website = parsed.website;
  if (present.has("ADR")) {
    patch.city = parsed.city;
    patch.region = parsed.region;
    patch.postal_code = parsed.postal_code;
    patch.country = parsed.country;
  }
  if (present.has("LINKEDIN")) patch.linkedin = parsed.linkedin;
  if (present.has("TWITTER")) patch.twitter = parsed.twitter;

  return { patch, emailDecision, preservedEmailOverBlank };
}
