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

// Escape a text value for a vCard property field.
function esc(v: string | null | undefined): string {
  if (!v) return "";
  return v
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

// Fold lines at 75 octets. iOS is forgiving but macOS Contacts is not.
function fold(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let i = 0;
  chunks.push(line.slice(0, 75));
  i = 75;
  while (i < line.length) {
    chunks.push(" " + line.slice(i, i + 74));
    i += 74;
  }
  return chunks.join("\r\n");
}

function line(name: string, value: string): string {
  return fold(`${name}:${value}`);
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

/**
 * Contact -> vCard 3.0 text. `phones` is optional; when omitted we skip TEL
 * lines from the phones table and only emit the encrypted `phone` field on
 * the contact itself.
 */
export function contactToVCard(contact: DecryptedContact, phones: PhoneRow[] = []): string {
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

  if (contact.email) {
    out.push(line("EMAIL;TYPE=INTERNET,WORK,pref", esc(contact.email)));
  }

  // Structured phones from contact_phones plus the legacy encrypted phone field.
  for (const p of phones) {
    if (!p.number) continue;
    const params = phoneTypeParam(p.label) + (p.is_primary ? ";TYPE=pref" : "");
    out.push(line(`TEL${params}`, esc(p.number)));
  }
  if (contact.phone && !phones.some((p) => p.number === contact.phone)) {
    out.push(line("TEL;TYPE=VOICE", esc(contact.phone)));
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
