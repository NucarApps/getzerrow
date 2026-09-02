/**
 * Form and selection logic for the add-contacts dialog.
 *
 * The dialog carries ten pieces of `useState`; the parts worth testing are
 * the manual form's validation and empty-to-null mapping, and the bulk
 * picker's selection algebra. Both were inline in the component.
 */

/** The manual tab's eight text fields. */
export type ManualContactForm = {
  email: string;
  name: string;
  title: string;
  company: string;
  phone: string;
  website: string;
  linkedin: string;
  twitter: string;
};

/** A blank manual form — also what closing the dialog resets to. */
export const EMPTY_MANUAL_CONTACT: ManualContactForm = {
  email: "",
  name: "",
  title: "",
  company: "",
  phone: "",
  website: "",
  linkedin: "",
  twitter: "",
};

/** What `createContactManual` is sent: every blank field becomes null. */
export type ManualContactPayload = {
  email: string;
  name: string | null;
  title: string | null;
  company: string | null;
  phone: string | null;
  website: string | null;
  linkedin: string | null;
  twitter: string | null;
};

/**
 * Client-side gate before the manual form is submitted. Deliberately loose —
 * it only insists on something, an @, and a dot in the domain, leaving real
 * validation to the server. It does not anchor, so surrounding text passes.
 */
export function isValidContactEmail(email: string): boolean {
  return /.+@.+\..+/.test(email);
}

/**
 * Map the manual form onto the create payload. Every optional field is
 * collapsed from "" to null so a blank input stores nothing rather than an
 * empty string; the email is sent as typed, since it is required.
 */
export function manualContactPayload(form: ManualContactForm): ManualContactPayload {
  return {
    email: form.email,
    name: form.name || null,
    title: form.title || null,
    company: form.company || null,
    phone: form.phone || null,
    website: form.website || null,
    linkedin: form.linkedin || null,
    twitter: form.twitter || null,
  };
}

/** Add or remove one person from the selection, without mutating the input. */
export function togglePerson(selected: ReadonlySet<string>, email: string): Set<string> {
  const next = new Set(selected);
  if (next.has(email)) next.delete(email);
  else next.add(email);
  return next;
}

/** Add or remove one folder from the inbox tab's scope filter. */
export function toggleFolder(folderIds: readonly string[], id: string): string[] {
  return folderIds.includes(id) ? folderIds.filter((x) => x !== id) : [...folderIds, id];
}

/**
 * True when every person currently listed is selected — which is what flips
 * the header control between "Select all visible" and "Unselect all". An
 * empty list is never "all selected", so the control stays disabled rather
 * than reading as a no-op unselect.
 */
export function allVisibleSelected(
  items: readonly { email: string }[],
  selected: ReadonlySet<string>,
): boolean {
  return items.length > 0 && items.every((s) => selected.has(s.email));
}

/**
 * Select every listed person, or unselect them all when they already are.
 * Selections not currently listed (someone filtered out by the search box)
 * are left alone either way.
 */
export function selectAllVisible(
  selected: ReadonlySet<string>,
  items: readonly { email: string }[],
): Set<string> {
  const clearing = allVisibleSelected(items, selected);
  const next = new Set(selected);
  for (const s of items) {
    if (clearing) next.delete(s.email);
    else next.add(s.email);
  }
  return next;
}

/**
 * The selected people, resolved back to the source rows so their names come
 * along. Anything selected on a list that is no longer loaded drops out.
 */
export function pickedPeople(
  source: readonly { email: string; name: string | null }[],
  selected: ReadonlySet<string>,
): Array<{ email: string; name: string | null }> {
  return source.filter((s) => selected.has(s.email)).map((s) => ({ email: s.email, name: s.name }));
}
