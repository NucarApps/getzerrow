// Build a VCARD 3.0 body for a contact. 3.0 is the version iOS parses most
// reliably for read-only address books. Escaping rules follow RFC 2426:
// backslash-escape commas, semicolons, backslashes, and newlines; fold long
// lines at 75 octets by injecting CRLF + single space.

import type { DecryptedContact } from "@/lib/sync/encrypted-reader";

export type PhoneRow = {
  label: string | null;
  number: string;
  is_primary: boolean | null;
};

export type EmailRow = {
  label: string | null;
  address: string;
  is_primary: boolean | null;
};


// Escape a text value for a vCard property field.
function esc(v: string | null | undefined): string {
  if (!v) return "";
  return v
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

// Fold at 75 OCTETS (RFC 6350 §3.2) — not JS chars. Unicode notes and names
// use multi-byte UTF-8; folding by `string.length` splits mid-codepoint and
// corrupts the value on parse. We walk codepoints, count encoded bytes, and
// only break on codepoint boundaries.
const encoder = new TextEncoder();
function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}
function fold(line: string): string {
  if (utf8Bytes(line) <= 75) return line;
  const chunks: string[] = [];
  let buf = "";
  let bufBytes = 0;
  let isFirst = true;
  const limit = () => (isFirst ? 75 : 74); // continuation lines start with 1-byte space.
  for (const cp of line) {
    const cpBytes = utf8Bytes(cp);
    if (bufBytes + cpBytes > limit()) {
      chunks.push(isFirst ? buf : " " + buf);
      isFirst = false;
      buf = "";
      bufBytes = 0;
    }
    buf += cp;
    bufBytes += cpBytes;
  }
  if (buf.length > 0) chunks.push(isFirst ? buf : " " + buf);
  return chunks.join("\r\n");
}

function line(name: string, value: string): string {
  return fold(`${name}:${value}`);
}

/** Digits-only key for phone-number comparison. iOS may reformat numbers on
 * every edit ("+1 555 1234" ↔ "(555) 1234"); we compare on digits so
 * round-trips don't accumulate duplicate TEL lines. */
export function phoneKey(s: string | null | undefined): string {
  return (s ?? "").replace(/\D+/g, "");
}

function phoneTypeParam(label: string | null): string {
  const l = (label ?? "").toLowerCase();
  if (l.includes("mobile") || l.includes("cell") || l.includes("iphone")) {
    return ";TYPE=CELL,VOICE";
  }
  if (l.includes("work") || l.includes("office")) return ";TYPE=WORK,VOICE";
  if (l.includes("home")) return ";TYPE=HOME,VOICE";
  if (l.includes("fax")) return ";TYPE=FAX";
  return ";TYPE=VOICE";
}

function emailTypeParam(label: string | null): string {
  const l = (label ?? "").toLowerCase();
  if (l.includes("work")) return ";TYPE=INTERNET,WORK";
  if (l.includes("home")) return ";TYPE=INTERNET,HOME";
  return ";TYPE=INTERNET";
}

function emailLabelFromTypes(types: string[]): string {
  const set = new Set(types.map((t) => t.toUpperCase()));
  if (set.has("WORK")) return "Work";
  if (set.has("HOME")) return "Home";
  return "Other";
}

/** Case-insensitive key for email dedupe. */
export function emailKey(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}


/**
 * Contact -> vCard 3.0 text. `phones` is optional; when omitted we skip TEL
 * lines from the phones table and only emit the encrypted `phone` field on
 * the contact itself.
 */
export function contactToVCard(
  contact: DecryptedContact,
  phones: PhoneRow[] = [],
  _categories: string[] = [],
  emails: EmailRow[] = [],
): string {
  const displayName = (contact.name && contact.name.trim()) || contact.email || "Unknown";

  // N: split "First Last" heuristically. iOS renders FN so the split just
  // has to be non-empty for the record to save cleanly.
  const parts = (contact.name ?? "").trim().split(/\s+/);
  const family = parts.length > 1 ? parts.slice(-1)[0] : "";
  const given = parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] ?? "");

  const out: string[] = [];
  out.push("BEGIN:VCARD");
  out.push("VERSION:3.0");
  out.push(line("PRODID", "-//Zerrow//CardDAV 1.0//EN"));
  out.push(line("UID", contact.id));
  out.push(line("FN", esc(displayName)));
  out.push(line("N", `${esc(family)};${esc(given)};;;`));

  if (contact.company || contact.title) {
    if (contact.company) out.push(line("ORG", esc(contact.company)));
    if (contact.title) out.push(line("TITLE", esc(contact.title)));
  }

  // Emit all EMAIL entries from contact_emails (fall back to the single
  // legacy contact.email column when no rows exist). Legacy placeholder
  // addresses are filtered so iOS stops caching them.
  const isPlaceholderEmail = (v: string): boolean =>
    /^carddav\+[0-9a-f-]+@local\.zerrow$/i.test(v);
  const emittedEmailKeys = new Set<string>();
  const emailList: EmailRow[] = emails.length
    ? emails
    : contact.email && !isPlaceholderEmail(contact.email)
      ? [{ label: "Work", address: contact.email, is_primary: true }]
      : [];
  // Ensure the primary comes first so iOS renders it as the default.
  const sortedEmails = [...emailList].sort((a, b) => {
    const ap = a.is_primary ? 0 : 1;
    const bp = b.is_primary ? 0 : 1;
    return ap - bp;
  });
  for (const em of sortedEmails) {
    const addr = em.address?.trim();
    if (!addr) continue;
    if (isPlaceholderEmail(addr)) continue;
    const key = emailKey(addr);
    if (key && emittedEmailKeys.has(key)) continue;
    const params = emailTypeParam(em.label) + (em.is_primary ? ",pref;PREF=1" : "");
    out.push(line(`EMAIL${params}`, esc(addr)));
    if (key) emittedEmailKeys.add(key);
  }


  // Structured phones from contact_phones plus the legacy encrypted phone field.
  const emittedPhoneKeys = new Set<string>();
  for (const p of phones) {
    if (!p.number) continue;
    const key = phoneKey(p.number);
    if (key && emittedPhoneKeys.has(key)) continue;
    // Emit both TYPE=pref (legacy 3.0) and PREF=1 (RFC 6350) so every client
    // recognizes the primary on the next fetch.
    const params = phoneTypeParam(p.label) + (p.is_primary ? ";TYPE=pref;PREF=1" : "");
    out.push(line(`TEL${params}`, esc(p.number)));
    if (key) emittedPhoneKeys.add(key);
  }
  if (contact.phone) {
    const encKey = phoneKey(contact.phone);
    if (encKey && !emittedPhoneKeys.has(encKey)) {
      out.push(line("TEL;TYPE=VOICE", esc(contact.phone)));
      emittedPhoneKeys.add(encKey);
    }
  }

  const hasAddr =
    contact.address_line1 ||
    contact.address_line2 ||
    contact.city ||
    contact.region ||
    contact.postal_code ||
    contact.country;
  if (hasAddr) {
    // ADR: pobox;ext;street;locality;region;postal;country
    const street = [contact.address_line1, contact.address_line2].filter(Boolean).join(", ");
    const adr = [
      "", // pobox
      "", // ext
      esc(street),
      esc(contact.city ?? ""),
      esc(contact.region ?? ""),
      esc(contact.postal_code ?? ""),
      esc(contact.country ?? ""),
    ].join(";");
    out.push(line("ADR;TYPE=WORK", adr));
  }

  if (contact.website) out.push(line("URL", esc(contact.website)));
  if (contact.linkedin) {
    out.push(line("URL;TYPE=LinkedIn", esc(contact.linkedin)));
  }
  if (contact.twitter) {
    out.push(line("URL;TYPE=Twitter", esc(contact.twitter)));
  }

  if (contact.notes) out.push(line("NOTE", esc(contact.notes)));

  // Intentionally NOT emitting CATEGORIES for group membership. iOS Contacts
  // materializes both KIND:group vCards AND CATEGORIES tags into separate
  // visible groups, so shipping both duplicates every group on the phone
  // (e.g. "Factory - Honda" from KIND:group PLUS "Honda" from CATEGORIES).
  // The KIND:group + MEMBER vCards are the canonical CardDAV mechanism.
  // Inbound CATEGORIES on iOS-side PUTs is still parsed in `parseVCard`.
  void _categories;

  // REV drives iOS's "last modified" and pairs with ETag for change detection.
  const rev = new Date(contact.updated_at).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  out.push(line("REV", rev));

  out.push("END:VCARD");
  return out.join("\r\n") + "\r\n";
}

/**
 * Stable ETag for a contact. Only depends on updated_at so iOS's incremental
 * refresh works: contact edit -> updated_at bumps -> ETag changes -> re-fetch.
 * Quoted per RFC 2616.
 */
export function contactETag(id: string, updatedAt: string): string {
  // Short deterministic hash; the value just needs to differ per revision.
  const src = `${id}:${updatedAt}`;
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) | 0;
  return `"${(h >>> 0).toString(16)}-${new Date(updatedAt).getTime().toString(36)}"`;
}

// ---------------------------------------------------------------------------
// vCard PARSER — handles what iOS emits on Add/Edit Contact: vCard 3.0,
// CRLF-folded lines, backslash escapes, TEL/EMAIL/ADR TYPE params. Not a
// full RFC 6350 parser — just the fields we round-trip in contactToVCard.

export type ParsedPhone = {
  label: string; // "Mobile" | "Work" | "Home" | "Fax" | "Other"
  number: string;
  is_primary: boolean;
};

export type ParsedEmail = {
  label: string; // "Work" | "Home" | "Other"
  address: string;
  is_primary: boolean;
};

export type PresentField =
  | "FN"
  | "ORG"
  | "TITLE"
  | "EMAIL"
  | "TEL"
  | "ADR"
  | "URL"
  | "LINKEDIN"
  | "TWITTER"
  | "NOTE"
  | "CATEGORIES"
  | "PHOTO";

export type ParsedVCard = {
  uid: string | null;
  name: string | null;
  /** Primary email — first PREF, else first non-empty. Kept for callers that
   * only care about a single address. All parsed addresses live in `emails`. */
  email: string | null;
  /** Every non-empty EMAIL line, deduped case-insensitively. Order preserves
   * the vCard, but the primary (PREF) is guaranteed to be first. */
  emails: ParsedEmail[];
  company: string | null;
  title: string | null;
  phones: ParsedPhone[];
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  website: string | null;
  linkedin: string | null;
  twitter: string | null;
  notes: string | null;

  /** iOS "CATEGORIES:" list — the group names the user checked in the
   * Contacts app. Empty when the card belongs to no groups. */
  categories: string[];
  /** True when this vCard represents an Apple-style group (KIND:group or
   * X-ADDRESSBOOKSERVER-KIND:group). */
  isGroup: boolean;
  /** Member contact UIDs for a group vCard. Empty for individuals. */
  memberUids: string[];
  /** Decoded PHOTO bytes if the vCard carried an inline base64 photo, plus
   * the declared mime type. Null when the vCard had no PHOTO line, an
   * empty PHOTO slot (iOS partial PUTs), or an unsupported PHOTO;VALUE=URI
   * reference we don't try to fetch. */
  photo: { bytes: Uint8Array; mime: string } | null;
  /** Set of top-level properties that actually appeared in the vCard body.
   * Used by CardDAV PUT to merge instead of replace — iOS routinely uploads
   * partial vCards for single-field edits and we must not clobber the
   * fields it omitted. */
  presentFields: Set<PresentField>;
};

function unescapeValue(v: string): string {
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === "\\" && i + 1 < v.length) {
      const n = v[i + 1];
      if (n === "n" || n === "N") out.push("\n");
      else out.push(n);
      i++;
    } else {
      out.push(c);
    }
  }
  return out.join("");
}

function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if ((l.startsWith(" ") || l.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += l.slice(1);
    } else {
      out.push(l);
    }
  }
  return out.filter((l) => l.length > 0);
}

type ParsedLine = { name: string; params: Record<string, string[]>; value: string };

function parseLine(raw: string): ParsedLine | null {
  const colonIdx = raw.indexOf(":");
  if (colonIdx < 0) return null;
  const head = raw.slice(0, colonIdx);
  const value = raw.slice(colonIdx + 1);
  const parts = head.split(";");
  // iOS groups properties with an `itemN.` prefix whenever they have an
  // associated X-ABLabel (custom labels), and often for the first
  // EMAIL/TEL/URL/ADR on a newly created contact. Strip the prefix so
  // downstream switches on the base property name still match.
  const rawName = parts[0].replace(/^item\d+\./i, "");
  const name = rawName.toUpperCase();
  const params: Record<string, string[]> = {};
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const eq = p.indexOf("=");
    if (eq < 0) {
      (params["TYPE"] ??= []).push(p.toUpperCase());
    } else {
      const key = p.slice(0, eq).toUpperCase();
      const vals = p.slice(eq + 1).split(",");
      (params[key] ??= []).push(...vals.map((v) => v.toUpperCase()));
    }
  }
  return { name, params, value };
}

function phoneLabelFromTypes(types: string[]): string {
  const set = new Set(types.map((t) => t.toUpperCase()));
  if (set.has("CELL") || set.has("MOBILE") || set.has("IPHONE")) return "Mobile";
  if (set.has("WORK")) return "Work";
  if (set.has("HOME")) return "Home";
  if (set.has("FAX")) return "Fax";
  return "Other";
}

/** Parse a vCard body into a normalized shape, or null if not a vCard. */
export function parseVCard(text: string): ParsedVCard | null {
  if (!/BEGIN:VCARD/i.test(text)) return null;
  const lines = unfold(text);
  const parsed: ParsedLine[] = [];
  for (const l of lines) {
    const p = parseLine(l);
    if (p) parsed.push(p);
  }

  const out: ParsedVCard = {
    uid: null, name: null, email: null, emails: [], company: null, title: null,
    phones: [], address_line1: null, address_line2: null, city: null,
    region: null, postal_code: null, country: null, website: null,
    linkedin: null, twitter: null, notes: null,
    categories: [], isGroup: false, memberUids: [],
    presentFields: new Set<PresentField>(),
  };


  let fn: string | null = null;
  let nGiven: string | null = null;
  let nFamily: string | null = null;

  for (const p of parsed) {
    const v = unescapeValue(p.value);
    switch (p.name) {
      case "UID":
        out.uid = v.trim() || null;
        break;
      case "FN": {
        const t = v.trim();
        if (t) {
          fn = t;
          out.presentFields.add("FN");
        }
        break;
      }
      case "N": {
        const segs = p.value.split(";").map(unescapeValue);
        nFamily = segs[0]?.trim() || null;
        nGiven = segs[1]?.trim() || null;
        if (nFamily || nGiven) out.presentFields.add("FN");
        break;
      }
      case "ORG": {
        const c = unescapeValue(p.value.split(";")[0] ?? "").trim();
        if (c) {
          out.company = c;
          out.presentFields.add("ORG");
        }
        break;
      }
      case "TITLE": {
        const t = v.trim();
        if (t) {
          out.title = t;
          out.presentFields.add("TITLE");
        }
        break;
      }
      case "EMAIL": {
        // Only treat EMAIL as "present" (and mergeable into the DB) when the
        // vCard actually carried a non-empty value. iOS routinely uploads
        // empty EMAIL slots on partial syncs; if we honored those we would
        // clobber the saved address with null.
        const em = v.trim();
        if (!em) break;
        const types = p.params.TYPE ?? [];
        const prefVals = (p.params.PREF ?? []).map((x) => x.trim());
        const isPref =
          types.includes("PREF") || prefVals.some((x) => x === "1" || x === "");
        out.emails.push({ label: emailLabelFromTypes(types), address: em, is_primary: isPref });
        if (!out.email) out.email = em;
        else if (isPref) out.email = em;
        out.presentFields.add("EMAIL");
        break;
      }

      case "TEL": {
        const num = v.trim();
        if (!num) break;
        out.presentFields.add("TEL");
        const types = p.params.TYPE ?? [];
        // Primary can arrive three ways:
        //   TEL;TYPE=pref:...    -> in TYPE array (parseLine uppercases)
        //   TEL;PREF=1:...       -> params.PREF = ["1"]
        //   TEL;PREF:...         -> bare param — parseLine routes to TYPE
        const prefVals = (p.params.PREF ?? []).map((x) => x.trim());
        const isPref =
          types.includes("PREF") || prefVals.some((x) => x === "1" || x === "");
        out.phones.push({ label: phoneLabelFromTypes(types), number: num, is_primary: isPref });
        break;
      }
      case "ADR": {
        const segs = p.value.split(";").map(unescapeValue);
        const street = (segs[2] ?? "").trim();
        const streetParts = street.split(/,\s*/);
        const line1 = streetParts[0] || null;
        const line2 = streetParts.slice(1).join(", ") || null;
        const city = (segs[3] ?? "").trim() || null;
        const region = (segs[4] ?? "").trim() || null;
        const postal = (segs[5] ?? "").trim() || null;
        const country = (segs[6] ?? "").trim() || null;
        if (!line1 && !line2 && !city && !region && !postal && !country) break;
        out.address_line1 = line1;
        out.address_line2 = line2;
        out.city = city;
        out.region = region;
        out.postal_code = postal;
        out.country = country;
        out.presentFields.add("ADR");
        break;
      }
      case "URL": {
        const url = v.trim();
        if (!url) break;
        const joined = (p.params.TYPE ?? []).join(",").toUpperCase();
        if (joined.includes("LINKEDIN") || /linkedin\.com/i.test(url)) {
          out.linkedin = url;
          out.presentFields.add("LINKEDIN");
        } else if (joined.includes("TWITTER") || /twitter\.com|x\.com/i.test(url)) {
          out.twitter = url;
          out.presentFields.add("TWITTER");
        } else if (!out.website) {
          out.website = url;
          out.presentFields.add("URL");
        }
        break;
      }
      case "NOTE": {
        if (!v) break;
        out.notes = v;
        out.presentFields.add("NOTE");
        break;
      }

      case "CATEGORIES": {
        out.presentFields.add("CATEGORIES");
        // Commas separate values; already-escaped commas were resolved by
        // unescapeValue, so re-split on unescaped commas via the raw value.
        const raw = p.value;
        const parts: string[] = [];
        let buf = "";
        for (let i = 0; i < raw.length; i++) {
          const c = raw[i];
          if (c === "\\" && i + 1 < raw.length) {
            buf += raw[i + 1];
            i++;
          } else if (c === ",") {
            if (buf.trim()) parts.push(buf.trim());
            buf = "";
          } else {
            buf += c;
          }
        }
        if (buf.trim()) parts.push(buf.trim());
        out.categories = parts;
        break;
      }
      case "KIND":
      case "X-ADDRESSBOOKSERVER-KIND":
        if (v.trim().toLowerCase() === "group") out.isGroup = true;
        break;
      case "MEMBER":
      case "X-ADDRESSBOOKSERVER-MEMBER": {
        // Format: urn:uuid:<uid>
        const m = v.trim().match(/urn:uuid:([0-9a-f-]{36})/i);
        if (m) out.memberUids.push(m[1].toLowerCase());
        break;
      }
      default:
        break;
    }
  }

  if (fn) {
    out.name = fn;
  } else if (nGiven || nFamily) {
    out.name = [nGiven, nFamily].filter(Boolean).join(" ").trim() || null;
  }

  // Dedupe phones by DIGITS ONLY (see phoneKey). Whitespace-only stripping
  // treats "+1 555 1234" and "(555) 1234" as different, which caused iOS to
  // accumulate duplicates on every round-trip.
  const seen = new Map<string, ParsedPhone>();
  for (const p of out.phones) {
    const key = phoneKey(p.number) || p.number.trim();
    const existing = seen.get(key);
    if (!existing) seen.set(key, p);
    else if (p.is_primary && !existing.is_primary) seen.set(key, p);
  }
  out.phones = Array.from(seen.values());

  // Dedupe emails case-insensitively; keep the PREF entry when both exist.
  const seenEmails = new Map<string, ParsedEmail>();
  for (const e of out.emails) {
    const k = emailKey(e.address);
    if (!k) continue;
    const existing = seenEmails.get(k);
    if (!existing) seenEmails.set(k, e);
    else if (e.is_primary && !existing.is_primary) seenEmails.set(k, e);
  }
  // Ensure exactly one primary and sort primary-first.
  let emailsArr = Array.from(seenEmails.values());
  if (emailsArr.length && !emailsArr.some((e) => e.is_primary)) {
    emailsArr[0] = { ...emailsArr[0], is_primary: true };
  }
  emailsArr = emailsArr.sort((a, b) => (a.is_primary === b.is_primary ? 0 : a.is_primary ? -1 : 1));
  out.emails = emailsArr;

  return out;
}


// ---------------------------------------------------------------------------
// GROUP vCARDS — Apple's Contacts app publishes groups as separate vCards
// with X-ADDRESSBOOKSERVER-KIND:group + X-ADDRESSBOOKSERVER-MEMBER lines.
// We serve these alongside contact vCards so iOS mirrors Zerrow groups.

export type GroupCardInput = {
  uid: string;
  name: string;
  memberContactIds: string[];
  updatedAt: string;
};

/** Build an Apple-style group vCard. Members reference contact UIDs which
 * must match the contacts.id used in the corresponding contact vCards. */
export function buildGroupVCard(g: GroupCardInput): string {
  const out: string[] = [];
  out.push("BEGIN:VCARD");
  out.push("VERSION:3.0");
  out.push(line("PRODID", "-//Zerrow//CardDAV Group 1.0//EN"));
  out.push(line("UID", g.uid));
  out.push(line("FN", esc(g.name)));
  out.push(line("N", `${esc(g.name)};;;;`));
  out.push("X-ADDRESSBOOKSERVER-KIND:group");
  for (const id of g.memberContactIds) {
    out.push(line("X-ADDRESSBOOKSERVER-MEMBER", `urn:uuid:${id}`));
  }
  const rev = new Date(g.updatedAt).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  out.push(line("REV", rev));
  out.push("END:VCARD");
  return out.join("\r\n") + "\r\n";
}

/** Stable ETag for a group vCard. Bumps whenever the group name or its
 * membership list changes (the trigger on contact_group_members updates
 * contact_groups.updated_at). */
export function groupETag(id: string, updatedAt: string): string {
  const src = `g:${id}:${updatedAt}`;
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) | 0;
  return `"${(h >>> 0).toString(16)}-${new Date(updatedAt).getTime().toString(36)}"`;
}
