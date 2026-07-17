// Handlers for the CardDAV splat route. iOS calls (in order):
//   1. PROPFIND / or /.well-known/carddav        - discover principal
//   2. PROPFIND /carddav/<email>/                - list address books
//   3. PROPFIND /carddav/<email>/contacts/       - CTag + resource list
//   4. REPORT   /carddav/<email>/contacts/       - addressbook-multiget
//   5. GET      /carddav/<email>/contacts/<id>.vcf
// We support the subset iOS's Contacts app + Fastmail/CardDAV clients need.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getContactDecrypted } from "@/lib/sync/encrypted-reader";
import { setContactEncryptedFields } from "@/lib/sync/encrypted-writer";
import {
  buildGroupVCard,
  contactETag,
  contactToVCard,
  groupETag,
  parseVCard,
  type PhoneRow,
} from "./vcard";
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
function groupHref(email: string, groupId: string): string {
  return `${BASE}/${encodeURIComponent(email)}/contacts/group-${groupId}.vcf`;
}

// Sum of contact update times; changes when any contact changes. iOS caches
// the whole book while the CTag is stable, so this must actually move on
// edits and stay stable otherwise.
async function computeBookCTag(userId: string): Promise<string> {
  // Include contact_groups.updated_at so group renames / membership changes
  // invalidate iOS's cached copy.
  const { data: cLatest } = await supabaseAdmin
    .from("contacts")
    .select("updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1);
  const { data: gLatest } = await supabaseAdmin
    .from("contact_groups")
    .select("updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1);
  const latest = [cLatest?.[0]?.updated_at, gLatest?.[0]?.updated_at]
    .filter((v): v is string => !!v)
    .sort()
    .pop() ?? "1970-01-01T00:00:00Z";
  const [{ count: cCount }, { count: gCount }] = await Promise.all([
    supabaseAdmin.from("contacts").select("id", { count: "exact", head: true }).eq("user_id", userId),
    supabaseAdmin.from("contact_groups").select("id", { count: "exact", head: true }).eq("user_id", userId),
  ]);
  return `"${new Date(latest).getTime().toString(36)}-${(cCount ?? 0)}-${(gCount ?? 0)}"`;
}

async function listContactRows(userId: string): Promise<Array<{ id: string; updated_at: string }>> {
  const { data } = await supabaseAdmin
    .from("contacts")
    .select("id,updated_at")
    .eq("user_id", userId)
    .limit(5000);
  return (data as Array<{ id: string; updated_at: string }> | null) ?? [];
}

type GroupRow = {
  id: string;
  name: string;
  updated_at: string;
  carddav_uid: string | null;
};

async function listGroupRows(userId: string): Promise<GroupRow[]> {
  const { data } = await supabaseAdmin
    .from("contact_groups")
    .select("id,name,updated_at,carddav_uid")
    .eq("user_id", userId)
    .limit(1000);
  return (data as GroupRow[] | null) ?? [];
}

async function fetchGroupMembers(groupId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("contact_group_members")
    .select("contact_id")
    .eq("group_id", groupId);
  return ((data as Array<{ contact_id: string }> | null) ?? []).map((r) => r.contact_id);
}

async function fetchCategoriesForContact(userId: string, contactId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("contact_group_members")
    .select("contact_groups!inner(name,user_id)")
    .eq("contact_id", contactId);
  const rows = (data as Array<{ contact_groups: { name: string; user_id: string } | null }> | null) ?? [];
  return rows
    .map((r) => r.contact_groups)
    .filter((g): g is { name: string; user_id: string } => !!g && g.user_id === userId)
    .map((g) => g.name);
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
      Allow: "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT",
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
    // Groups appear as their own vCards (Apple X-ADDRESSBOOKSERVER-KIND).
    const groups = await listGroupRows(userId);
    for (const g of groups) {
      const etag = groupETag(g.id, g.updated_at);
      const props =
        `<D:resourcetype/>` +
        `<D:getetag>${xmlEscape(etag)}</D:getetag>` +
        `<D:getcontenttype>text/vcard; charset=utf-8</D:getcontenttype>`;
      body += responseBlock(groupHref(email, g.id), props);
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

async function buildContactResponse(
  userId: string,
  email: string,
  contactId: string,
  includeVcard: boolean,
): Promise<string> {
  const { row } = await getContactDecrypted(contactId);
  if (!row) {
    return (
      `<D:response>` +
      `<D:href>${contactHref(email, contactId)}</D:href>` +
      `<D:status>HTTP/1.1 404 Not Found</D:status>` +
      `</D:response>`
    );
  }
  const [phones, categories] = await Promise.all([
    fetchPhones(contactId),
    fetchCategoriesForContact(userId, contactId),
  ]);
  const vcard = contactToVCard(row, phones, categories);
  const etag = contactETag(row.id, row.updated_at);
  const props =
    `<D:getetag>${xmlEscape(etag)}</D:getetag>` +
    (includeVcard ? `<C:address-data>${xmlEscape(vcard)}</C:address-data>` : "");
  return responseBlock(contactHref(email, contactId), props);
}

async function buildGroupResponse(
  userId: string,
  email: string,
  groupId: string,
  includeVcard: boolean,
): Promise<string> {
  const { data: group } = await supabaseAdmin
    .from("contact_groups")
    .select("id,name,updated_at,carddav_uid")
    .eq("id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!group) {
    return (
      `<D:response>` +
      `<D:href>${groupHref(email, groupId)}</D:href>` +
      `<D:status>HTTP/1.1 404 Not Found</D:status>` +
      `</D:response>`
    );
  }
  const members = await fetchGroupMembers(group.id);
  const vcard = buildGroupVCard({
    uid: group.carddav_uid ?? `group-${group.id}`,
    name: group.name,
    memberContactIds: members,
    updatedAt: group.updated_at,
  });
  const etag = groupETag(group.id, group.updated_at);
  const props =
    `<D:getetag>${xmlEscape(etag)}</D:getetag>` +
    (includeVcard ? `<C:address-data>${xmlEscape(vcard)}</C:address-data>` : "");
  return responseBlock(groupHref(email, group.id), props);
}

export async function handleReport(
  request: Request,
  userId: string,
  email: string,
): Promise<Response> {
  const raw = await request.text();
  const lower = raw.toLowerCase();
  const includeVcard = lower.includes("address-data");


  const contactIds: string[] = [];
  const groupIds: string[] = [];
  if (lower.includes("addressbook-multiget")) {
    const hrefs = parseMultigetHrefs(raw);
    for (const h of hrefs) {
      const g = h.match(/group-([0-9a-f-]{36})\.vcf$/i);
      if (g) {
        groupIds.push(g[1]);
        continue;
      }
      const c = h.match(/([0-9a-f-]{36})\.vcf$/i);
      if (c) contactIds.push(c[1]);
    }
  } else {
    const [rows, groups] = await Promise.all([listContactRows(userId), listGroupRows(userId)]);
    contactIds.push(...rows.map((r) => r.id));
    groupIds.push(...groups.map((g) => g.id));
  }

  let body = MULTISTATUS_OPEN;
  if (contactIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("user_id", userId)
      .in("id", contactIds);
    const owned = new Set(((data as Array<{ id: string }> | null) ?? []).map((r) => r.id));
    for (const id of contactIds) {
      if (!owned.has(id)) continue;
      body += await buildContactResponse(userId, email, id, includeVcard);
    }
  }
  if (groupIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("contact_groups")
      .select("id")
      .eq("user_id", userId)
      .in("id", groupIds);
    const owned = new Set(((data as Array<{ id: string }> | null) ?? []).map((r) => r.id));
    for (const id of groupIds) {
      if (!owned.has(id)) continue;
      body += await buildGroupResponse(userId, email, id, includeVcard);
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
  const gm = path.match(/group-([0-9a-f-]{36})\.vcf$/i);
  if (gm) {
    const groupId = gm[1];
    const { data: group } = await supabaseAdmin
      .from("contact_groups")
      .select("id,name,updated_at,carddav_uid")
      .eq("id", groupId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!group) return new Response("Not found", { status: 404 });
    const members = await fetchGroupMembers(group.id);
    const vcard = buildGroupVCard({
      uid: group.carddav_uid ?? `group-${group.id}`,
      name: group.name,
      memberContactIds: members,
      updatedAt: group.updated_at,
    });
    return new Response(method === "HEAD" ? null : vcard, {
      status: 200,
      headers: {
        "Content-Type": 'text/vcard; charset="utf-8"',
        ETag: groupETag(group.id, group.updated_at),
        "Cache-Control": "no-cache",
      },
    });
  }

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
  const [phones, categories] = await Promise.all([
    fetchPhones(contactId),
    fetchCategoriesForContact(userId, contactId),
  ]);
  const vcard = contactToVCard(row, phones, categories);
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

// -----------------------------------------------------------------------------
// PUT / DELETE (two-way sync)

const UUID_RE = /^[0-9a-f-]{36}$/i;

function extractGroupId(path: string): string | null {
  const m = path.match(/group-([0-9a-f-]{36})\.vcf$/i);
  return m ? m[1].toLowerCase() : null;
}

function extractContactId(path: string): string | null {
  // Skip if this is a group resource — group ids share the UUID pattern
  // but live under group-<uuid>.vcf and must be routed separately.
  if (extractGroupId(path)) return null;
  const m = path.match(/([0-9a-f-]{36})\.vcf$/i);
  return m ? m[1].toLowerCase() : null;
}

function preconditionFailed(): Response {
  return new Response("Precondition Failed", { status: 412 });
}

// Handle PUT: iOS uploads a full vCard for create or replace. We honor
// If-Match (must match current ETag) and If-None-Match: * (must not exist).
// Ownership is enforced by the verified auth userId, never the vCard UID.
export async function handlePut(
  request: Request,
  userId: string,
  email: string,
  path: string,
): Promise<Response> {
  const contactId = extractContactId(path);
  if (!contactId || !UUID_RE.test(contactId)) {
    return new Response("Bad Request", { status: 400 });
  }

  const body = await request.text();
  const parsed = parseVCard(body);
  if (!parsed) return new Response("Unparseable vCard", { status: 400 });

  const { data: existing } = await supabaseAdmin
    .from("contacts")
    .select("id,updated_at,email,source")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();

  const ifMatch = request.headers.get("if-match");
  const ifNoneMatch = request.headers.get("if-none-match");

  if (ifNoneMatch === "*" && existing) return preconditionFailed();
  if (ifMatch && existing) {
    const current = contactETag(existing.id, existing.updated_at as string);
    // Accept either quoted or unquoted comparison.
    const norm = (v: string) => v.trim().replace(/^W\//i, "");
    if (norm(ifMatch) !== norm(current)) return preconditionFailed();
  }
  if (ifMatch && !existing) return preconditionFailed();

  // iOS may omit EMAIL for a new personal contact; contacts.email is NOT NULL
  // in the schema. Synthesize a stable placeholder tied to the UID so we
  // never overwrite an existing contact by email collision.
  const emailForRow =
    (parsed.email && parsed.email.trim().toLowerCase()) ||
    existing?.email ||
    `carddav+${contactId}@local.zerrow`;

  const nowIso = new Date().toISOString();
  const plaintextPatch = {
    user_id: userId,
    email: emailForRow,
    name: parsed.name,
    company: parsed.company,
    title: parsed.title,
    website: parsed.website,
    city: parsed.city,
    region: parsed.region,
    postal_code: parsed.postal_code,
    country: parsed.country,
    linkedin: parsed.linkedin,
    twitter: parsed.twitter,
    source: existing?.source ?? "carddav",
    updated_at: nowIso,
  };

  if (existing) {
    const { error: upErr } = await supabaseAdmin
      .from("contacts")
      .update(plaintextPatch)
      .eq("id", contactId)
      .eq("user_id", userId);
    if (upErr) return new Response(upErr.message, { status: 500 });
  } else {
    const { error: insErr } = await supabaseAdmin
      .from("contacts")
      .insert({ id: contactId, ...plaintextPatch });
    if (insErr) return new Response(insErr.message, { status: 500 });
  }

  // Encrypted fields. The RPC treats NULL as "leave unchanged", so use "" to
  // clear a value the user wiped on the phone.
  const primaryPhone = parsed.phones.find((p) => p.is_primary)?.number ?? parsed.phones[0]?.number ?? "";
  const encErr = await setContactEncryptedFields({
    contact_id: contactId,
    notes: parsed.notes ?? "",
    address_line1: parsed.address_line1 ?? "",
    address_line2: parsed.address_line2 ?? "",
    phone: primaryPhone,
  });
  if (encErr.error) return new Response(encErr.error, { status: 500 });

  // Replace-all phones. RLS scopes to the caller via user_id filter.
  const { error: delPhoneErr } = await supabaseAdmin
    .from("contact_phones")
    .delete()
    .eq("contact_id", contactId)
    .eq("user_id", userId);
  if (delPhoneErr) return new Response(delPhoneErr.message, { status: 500 });

  if (parsed.phones.length > 0) {
    const hasPrimary = parsed.phones.some((p) => p.is_primary);
    const rows = parsed.phones.map((p, idx) => ({
      user_id: userId,
      contact_id: contactId,
      label: p.label.toLowerCase(),
      number: p.number,
      is_primary: hasPrimary ? p.is_primary : idx === 0,
      position: idx,
    }));
    const { error: insPhoneErr } = await supabaseAdmin.from("contact_phones").insert(rows);
    if (insPhoneErr) return new Response(insPhoneErr.message, { status: 500 });
  }

  const newEtag = contactETag(contactId, nowIso);
  return new Response(null, {
    status: existing ? 204 : 201,
    headers: {
      ETag: newEtag,
      Location: contactHref(email, contactId),
    },
  });
}

// Handle DELETE: hard-delete the contact and cascade its phones.
export async function handleDelete(
  request: Request,
  userId: string,
  path: string,
): Promise<Response> {
  const contactId = extractContactId(path);
  if (!contactId || !UUID_RE.test(contactId)) {
    return new Response("Bad Request", { status: 400 });
  }

  const { data: existing } = await supabaseAdmin
    .from("contacts")
    .select("id,updated_at")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!existing) return new Response(null, { status: 404 });

  const ifMatch = request.headers.get("if-match");
  if (ifMatch) {
    const current = contactETag(existing.id, existing.updated_at as string);
    const norm = (v: string) => v.trim().replace(/^W\//i, "");
    if (norm(ifMatch) !== norm(current)) return preconditionFailed();
  }

  // Phones first (no FK cascade guarantee across schemas).
  await supabaseAdmin
    .from("contact_phones")
    .delete()
    .eq("contact_id", contactId)
    .eq("user_id", userId);

  const { error } = await supabaseAdmin
    .from("contacts")
    .delete()
    .eq("id", contactId)
    .eq("user_id", userId);
  if (error) return new Response(error.message, { status: 500 });

  return new Response(null, { status: 204 });
}
