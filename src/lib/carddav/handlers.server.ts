// Handlers for the CardDAV splat route. iOS calls (in order):
//   1. PROPFIND / or /.well-known/carddav        - discover principal
//   2. PROPFIND /carddav/<email>/                - list address books
//   3. PROPFIND /carddav/<email>/contacts/       - CTag + resource list
//   4. REPORT   /carddav/<email>/contacts/       - addressbook-multiget
//   5. GET      /carddav/<email>/contacts/<id>.vcf
// We support the subset iOS's Contacts app + Fastmail/CardDAV clients need.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getContactDecrypted } from "@/lib/sync/encrypted-reader";
import { contactETag, contactToVCard, type PhoneRow } from "./vcard";
import {
  davResponse,
  MULTISTATUS_CLOSE,
  MULTISTATUS_OPEN,
  parseMultigetHrefs,
  responseBlock,
  xmlEscape,
} from "./xml";

const BASE = "/api/public/carddav";

function principalHref(email: string): string {
  return `${BASE}/${encodeURIComponent(email)}/`;
}
function addressbookHref(email: string): string {
  return `${BASE}/${encodeURIComponent(email)}/contacts/`;
}
function contactHref(email: string, contactId: string): string {
  return `${BASE}/${encodeURIComponent(email)}/contacts/${contactId}.vcf`;
}

// Sum of contact update times; changes when any contact changes. iOS caches
// the whole book while the CTag is stable, so this must actually move on
// edits and stay stable otherwise.
async function computeBookCTag(userId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("contacts")
    .select("updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1);
  const latest = data?.[0]?.updated_at ?? "1970-01-01T00:00:00Z";
  const { count } = await supabaseAdmin
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  return `"${new Date(latest).getTime().toString(36)}-${count ?? 0}"`;
}

async function listContactRows(userId: string): Promise<Array<{ id: string; updated_at: string }>> {
  const { data } = await supabaseAdmin
    .from("contacts")
    .select("id,updated_at")
    .eq("user_id", userId)
    .limit(5000);
  return (data as Array<{ id: string; updated_at: string }> | null) ?? [];
}

async function fetchPhones(contactId: string): Promise<PhoneRow[]> {
  const { data } = await supabaseAdmin
    .from("contact_phones")
    .select("label,number,is_primary,position")
    .eq("contact_id", contactId)
    .order("position", { ascending: true });
  return ((data as PhoneRow[] | null) ?? []).map((r) => ({
    label: r.label,
    number: r.number,
    is_primary: r.is_primary,
  }));
}

// -----------------------------------------------------------------------------
// OPTIONS

export function handleOptions(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      DAV: "1, 3, addressbook",
      Allow: "OPTIONS, GET, HEAD, PROPFIND, REPORT",
      "Content-Length": "0",
    },
  });
}

// -----------------------------------------------------------------------------
// PROPFIND

// Root or principal-level PROPFIND: point iOS at the user's principal +
// addressbook home.
function propfindPrincipal(email: string, depth: string): Response {
  const principal = principalHref(email);
  const book = addressbookHref(email);

  const principalProps =
    `<D:resourcetype><D:collection/><D:principal/></D:resourcetype>` +
    `<D:displayname>${xmlEscape(email)}</D:displayname>` +
    `<D:current-user-principal><D:href>${principal}</D:href></D:current-user-principal>` +
    `<D:principal-URL><D:href>${principal}</D:href></D:principal-URL>` +
    `<C:addressbook-home-set><D:href>${principal}</D:href></C:addressbook-home-set>`;

  let body = MULTISTATUS_OPEN + responseBlock(principal, principalProps);

  if (depth === "1") {
    const bookProps =
      `<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>` +
      `<D:displayname>Zerrow Contacts</D:displayname>` +
      `<C:addressbook-description>Contacts synced from Zerrow</C:addressbook-description>` +
      `<C:supported-address-data>` +
      `<C:address-data-type content-type="text/vcard" version="3.0"/>` +
      `</C:supported-address-data>`;
    body += responseBlock(book, bookProps);
  }
  body += MULTISTATUS_CLOSE;
  return davResponse(body);
}

// Addressbook-level PROPFIND: return CTag + one <response> per contact.
async function propfindAddressbook(userId: string, email: string, depth: string): Promise<Response> {
  const book = addressbookHref(email);
  const ctag = await computeBookCTag(userId);

  const bookProps =
    `<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>` +
    `<D:displayname>Zerrow Contacts</D:displayname>` +
    `<CS:getctag>${xmlEscape(ctag)}</CS:getctag>` +
    `<C:supported-address-data>` +
    `<C:address-data-type content-type="text/vcard" version="3.0"/>` +
    `</C:supported-address-data>`;

  let body = MULTISTATUS_OPEN + responseBlock(book, bookProps);

  if (depth === "1") {
    const rows = await listContactRows(userId);
    for (const row of rows) {
      const etag = contactETag(row.id, row.updated_at);
      const props =
        `<D:resourcetype/>` +
        `<D:getetag>${xmlEscape(etag)}</D:getetag>` +
        `<D:getcontenttype>text/vcard; charset=utf-8</D:getcontenttype>`;
      body += responseBlock(contactHref(email, row.id), props);
    }
  }
  body += MULTISTATUS_CLOSE;
  return davResponse(body, { "Cache-Control": "no-cache" });
}

export async function handlePropfind(
  request: Request,
  userId: string,
  email: string,
  path: string,
): Promise<Response> {
  const depth = request.headers.get("depth") ?? "0";
  // path is what came after /api/public/carddav/, e.g. "" or "<email>/" or
  // "<email>/contacts/".
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const segments = trimmed.length ? trimmed.split("/") : [];

  if (segments.length <= 1) {
    // "/" or "/<email>/" -> principal view
    return propfindPrincipal(email, depth);
  }
  if (segments.length === 2 && segments[1] === "contacts") {
    return propfindAddressbook(userId, email, depth);
  }
  // Unknown depth: fall back to empty multistatus so iOS doesn't error.
  return davResponse(MULTISTATUS_OPEN + MULTISTATUS_CLOSE);
}

// -----------------------------------------------------------------------------
// REPORT (addressbook-multiget / addressbook-query)

async function buildContactResponse(email: string, contactId: string, includeVcard: boolean): Promise<string> {
  const { row } = await getContactDecrypted(contactId);
  if (!row) {
    return (
      `<D:response>` +
      `<D:href>${contactHref(email, contactId)}</D:href>` +
      `<D:status>HTTP/1.1 404 Not Found</D:status>` +
      `</D:response>`
    );
  }
  const phones = await fetchPhones(contactId);
  const vcard = contactToVCard(row, phones);
  const etag = contactETag(row.id, row.updated_at);
  const props =
    `<D:getetag>${xmlEscape(etag)}</D:getetag>` +
    (includeVcard ? `<C:address-data>${xmlEscape(vcard)}</C:address-data>` : "");
  return responseBlock(contactHref(email, contactId), props);
}

export async function handleReport(
  request: Request,
  userId: string,
  email: string,
): Promise<Response> {
  const raw = await request.text();
  const lower = raw.toLowerCase();
  const includeVcard = lower.includes("address-data");

  let ids: string[] = [];
  if (lower.includes("addressbook-multiget")) {
    const hrefs = parseMultigetHrefs(raw);
    ids = hrefs
      .map((h) => {
        const m = h.match(/([0-9a-f-]{36})\.vcf$/i);
        return m ? m[1] : null;
      })
      .filter((v): v is string => !!v);
  } else {
    // addressbook-query or sync-collection fallback: return every contact.
    const rows = await listContactRows(userId);
    ids = rows.map((r) => r.id);
  }

  let body = MULTISTATUS_OPEN;
  // Verify each id belongs to the caller before decrypting.
  if (ids.length > 0) {
    const { data } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("user_id", userId)
      .in("id", ids);
    const owned = new Set(((data as Array<{ id: string }> | null) ?? []).map((r) => r.id));
    for (const id of ids) {
      if (!owned.has(id)) continue;
      body += await buildContactResponse(email, id, includeVcard);
    }
  }
  body += MULTISTATUS_CLOSE;
  return davResponse(body);
}

// -----------------------------------------------------------------------------
// GET / HEAD on a single .vcf

export async function handleGet(
  userId: string,
  email: string,
  path: string,
  method: "GET" | "HEAD",
): Promise<Response> {
  const m = path.match(/([0-9a-f-]{36})\.vcf$/i);
  if (!m) return new Response("Not found", { status: 404 });
  const contactId = m[1];

  const { data: owner } = await supabaseAdmin
    .from("contacts")
    .select("id,updated_at")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!owner) return new Response("Not found", { status: 404 });

  const { row } = await getContactDecrypted(contactId);
  if (!row) return new Response("Not found", { status: 404 });
  const phones = await fetchPhones(contactId);
  const vcard = contactToVCard(row, phones);
  const etag = contactETag(row.id, row.updated_at);

  return new Response(method === "HEAD" ? null : vcard, {
    status: 200,
    headers: {
      "Content-Type": 'text/vcard; charset="utf-8"',
      ETag: etag,
      "Cache-Control": "no-cache",
    },
  });
}
