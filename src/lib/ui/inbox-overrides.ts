// Validation for the "always send to inbox" list.
//
// The list is keyed by a normalised value, so the normalisation and the
// email-vs-domain check decide what actually lands in the database — a
// mistyped entry here is a rule that silently never fires.

export type OverrideMatchType = "email" | "domain";

export type OverrideInput = {
  /** Exactly what the user typed. */
  raw: string;
  /** Which tab of the add form they are on. */
  matchType: OverrideMatchType;
  /** The Gmail account the entry would belong to, if one is selected. */
  accountId: string | null;
};

export type OverrideValidation =
  | { ok: true; value: string; matchType: OverrideMatchType }
  /** Nothing typed yet: the form does nothing at all, not even complain. */
  | { ok: false; reason: "empty"; message: null }
  | { ok: false; reason: "no_account"; message: string }
  | { ok: false; reason: "not_an_email"; message: string }
  | { ok: false; reason: "not_a_domain"; message: string };

/**
 * Decide whether an add is allowed, and what value it would store.
 *
 * The value is trimmed and lower-cased first: the inbox-override matcher
 * compares against lower-cased addresses and domains, so "  Acme.COM " and
 * "acme.com" have to become the same row rather than two rows of which one
 * never matches.
 *
 * Duplicates are NOT checked here — the database's unique key is the only
 * guard (see the pinned characterization in the test).
 */
export function validateOverrideInput({
  raw,
  matchType,
  accountId,
}: OverrideInput): OverrideValidation {
  const value = raw.trim().toLowerCase();
  if (!value) return { ok: false, reason: "empty", message: null };
  if (!accountId) {
    return { ok: false, reason: "no_account", message: "Pick a Gmail account first" };
  }
  if (matchType === "email" && !value.includes("@")) {
    return { ok: false, reason: "not_an_email", message: "Enter a full email address" };
  }
  if (matchType === "domain" && value.includes("@")) {
    return {
      ok: false,
      reason: "not_a_domain",
      message: "Enter a domain only (e.g. example.com)",
    };
  }
  return { ok: true, value, matchType };
}
