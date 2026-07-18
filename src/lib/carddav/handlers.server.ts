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
  parseSyncCollection,
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
  // invalidate iOS's cached copy. Include tombstone max seq so hard deletes
  // also bump the CTag.
  const [{ data: cLatest }, { data: gLatest }, { data: tLatest }] =
    await Promise.all([
      supabaseAdmin
        .from("contacts")
        .select("updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(1),
      supabaseAdmin
        .from("contact_groups")
        .select("updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(1),
      supabaseAdmin
        .from("carddav_tombstones")
        .select("sync_seq")
        .eq("user_id", userId)
        .order("sync_seq", { ascending: false })
        .limit(1),
    ]);
  const latest = [cLatest?.[0]?.updated_at, gLatest?.[0]?.updated_at]
    .filter((v): v is string => !!v)
    .sort()
    .pop() ?? "1970-01-01T00:00:00Z";
  const tombSeq = (tLatest?.[0] as { sync_seq: number } | undefined)?.sync_seq ?? 0;
  const [{ count: cCount }, { count: gCount }] = await Promise.all([
    supabaseAdmin.from("contacts").select("id", { count: "exact", head: true }).eq("user_id", userId),
    supabaseAdmin.from("contact_groups").select("id", { count: "exact", head: true }).eq("user_id", userId),
  ]);
  const style = await getGroupNameStyle(userId);
  const nonce = await getResyncNonce(userId);
  // "v2" bump: shipped with the fix that stops emitting CATEGORIES on contact
  // vCards. Forces every iPhone to do a full compare on next poll so stale
  // duplicate CATEGORIES-derived groups get cleaned up.
  return `"${new Date(latest).getTime().toString(36)}-${(cCount ?? 0)}-${(gCount ?? 0)}-${tombSeq}-${style}-${nonce}-v2"`;
}

/** Manually bumped counter that participates in the book CTag. Users hit
 * "Force iPhone resync" in Settings to increment it, which makes iOS treat
 * the entire address book as changed on its next poll. */
export async function getResyncNonce(userId: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from("carddav_settings")
    .select("resync_nonce")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as { resync_nonce?: number } | null)?.resync_nonce ?? 0;
}

// User-selectable format for group vCards on iPhone. iOS Contacts only
// displays a flat group list, so nested Zerrow groups need their display
// name flattened. Options:
//   leaf       -> "Toyota"
//   path_slash -> "Factory / Toyota" (default)
//   path_dash  -> "Factory - Toyota"
export type GroupNameStyle = "leaf" | "path_slash" | "path_dash";

export async function getGroupNameStyle(userId: string): Promise<GroupNameStyle> {
  const { data } = await supabaseAdmin
    .from("carddav_settings")
    .select("group_name_style")
    .eq("user_id", userId)
    .maybeSingle();
  const v = (data as { group_name_style?: string } | null)?.group_name_style;
  return v === "leaf" || v === "path_dash" ? v : "path_slash";
}

const SYNC_TOKEN_PREFIX = "urn:zerrow:carddav:";

type SyncState = { updatedSince: string; seqSince: number };

function buildSyncToken(userId: string, updatedAtIso: string, seq: number): string {
  const ms = new Date(updatedAtIso).getTime();
  return `${SYNC_TOKEN_PREFIX}${userId}:${ms}:${seq}`;
}

function parseSyncToken(userId: string, token: string): SyncState | null {
  if (!token || !token.startsWith(SYNC_TOKEN_PREFIX)) return null;
  const rest = token.slice(SYNC_TOKEN_PREFIX.length);
  const [uid, msStr, seqStr] = rest.split(":");
  if (uid !== userId) return null;
  const ms = Number.parseInt(msStr ?? "", 10);
  const seq = Number.parseInt(seqStr ?? "", 10);
  if (!Number.isFinite(ms) || !Number.isFinite(seq)) return null;
  return { updatedSince: new Date(ms).toISOString(), seqSince: seq };
}

async function currentSyncSnapshot(userId: string): Promise<{ updatedAt: string; seq: number }> {
  const [{ data: cLatest }, { data: gLatest }, { data: tLatest }] =
    await Promise.all([
      supabaseAdmin
        .from("contacts")
        .select("updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(1),
      supabaseAdmin
        .from("contact_groups")
        .select("updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(1),
      supabaseAdmin
        .from("carddav_tombstones")
        .select("sync_seq")
        .eq("user_id", userId)
        .order("sync_seq", { ascending: false })
        .limit(1),
    ]);
  const updatedAt = [cLatest?.[0]?.updated_at, gLatest?.[0]?.updated_at]
    .filter((v): v is string => !!v)
    .sort()
    .pop() ?? "1970-01-01T00:00:00Z";
  const seq = (tLatest?.[0] as { sync_seq: number } | undefined)?.sync_seq ?? 0;
  return { updatedAt, seq };
}

async function insertTombstone(
  userId: string,
  resourceType: "contact" | "group",
  resourceId: string,
): Promise<void> {
  await supabaseAdmin
    .from("carddav_tombstones")
    .upsert(
      { user_id: userId, resource_type: resourceType, resource_id: resourceId, deleted_at: new Date().toISOString() },
      { onConflict: "user_id,resource_type,resource_id" },
    );
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
  const snap = await currentSyncSnapshot(userId);
  const syncToken = buildSyncToken(userId, snap.updatedAt, snap.seq);

  const bookProps =
    `<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>` +
    `<D:displayname>Zerrow Contacts</D:displayname>` +
    `<CS:getctag>${xmlEscape(ctag)}</CS:getctag>` +
    `<D:sync-token>${xmlEscape(syncToken)}</D:sync-token>` +
    `<D:supported-report-set>` +
    `<D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report>` +
    `<D:supported-report><D:report><C:addressbook-multiget/></D:report></D:supported-report>` +
    `<D:supported-report><D:report><C:addressbook-query/></D:report></D:supported-report>` +
    `</D:supported-report-set>` +
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
  style: GroupNameStyle,
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
  const displayName = await resolveGroupDisplayName(userId, group.id, group.name, style);
  const vcard = buildGroupVCard({
    uid: group.carddav_uid ?? `group-${group.id}`,
    name: displayName,
    memberContactIds: members,
    updatedAt: group.updated_at,
  });
  const etag = groupETag(group.id, group.updated_at);
  const props =
    `<D:getetag>${xmlEscape(etag)}</D:getetag>` +
    (includeVcard ? `<C:address-data>${xmlEscape(vcard)}</C:address-data>` : "");
  return responseBlock(groupHref(email, group.id), props);
}

/** Resolve a group's display name to its full nested path
 * ("Clients / VIPs") so iOS can distinguish nested Zerrow groups. Apple's
 * KIND:group vCard has no native parent field. */
async function resolveGroupDisplayName(
  userId: string,
  groupId: string,
  ownName: string,
  style: GroupNameStyle,
): Promise<string> {
  if (style === "leaf") return ownName;
  const { data } = await supabaseAdmin
    .from("contact_groups")
    .select("id,name,parent_group_id")
    .eq("user_id", userId);
  const byId = new Map<string, { name: string; parent: string | null }>();
  for (const g of data ?? [])
    byId.set(g.id, { name: g.name, parent: g.parent_group_id ?? null });
  const own = byId.get(groupId);
  if (!own) return ownName;
  const parts: string[] = [];
  let cursor: string | null = groupId;
  let hops = 0;
  while (cursor && hops < 8) {
    const node = byId.get(cursor);
    if (!node) break;
    parts.unshift(node.name);
    cursor = node.parent;
    hops++;
  }
  const sep = style === "path_dash" ? " - " : " / ";
  return parts.length > 1 ? parts.join(sep) : ownName;
}

const TOMBSTONE_PRUNE_DAYS = 90;

async function handleSyncCollection(
  raw: string,
  userId: string,
  email: string,
): Promise<Response> {
  const { syncToken, syncLevel, limit } = parseSyncCollection(raw);
  const includeVcard = raw.toLowerCase().includes("address-data");

  if (syncLevel !== "1" && syncLevel !== "infinite") {
    return new Response(
      '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>',
      { status: 400, headers: { "Content-Type": 'application/xml; charset="utf-8"' } },
    );
  }

  const snap = await currentSyncSnapshot(userId);

  // Empty token = initial sync: return everything currently present.
  let since: SyncState = { updatedSince: "1970-01-01T00:00:00Z", seqSince: 0 };
  if (syncToken) {
    const parsed = parseSyncToken(userId, syncToken);
    if (!parsed) {
      return new Response(
        '<?xml version="1.0" encoding="utf-8"?>\n' +
          '<D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>',
        { status: 403, headers: { "Content-Type": 'application/xml; charset="utf-8"' } },
      );
    }
    // Reject tokens older than our tombstone horizon — the RFC-defined
    // fallback is a full resync via addressbook-multiget.
    const horizonMs = Date.now() - TOMBSTONE_PRUNE_DAYS * 24 * 60 * 60 * 1000;
    if (new Date(parsed.updatedSince).getTime() < horizonMs) {
      return new Response(
        '<?xml version="1.0" encoding="utf-8"?>\n' +
          '<D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>',
        { status: 403, headers: { "Content-Type": 'application/xml; charset="utf-8"' } },
      );
    }
    since = parsed;
  }

  const [{ data: cRows }, { data: gRows }, { data: tRows }] = await Promise.all([
    supabaseAdmin
      .from("contacts")
      .select("id,updated_at")
      .eq("user_id", userId)
      .gt("updated_at", since.updatedSince)
      .order("updated_at", { ascending: true })
      .limit(limit ?? 5000),
    supabaseAdmin
      .from("contact_groups")
      .select("id,updated_at")
      .eq("user_id", userId)
      .gt("updated_at", since.updatedSince)
      .order("updated_at", { ascending: true })
      .limit(limit ?? 1000),
    supabaseAdmin
      .from("carddav_tombstones")
      .select("resource_type,resource_id,sync_seq")
      .eq("user_id", userId)
      .gt("sync_seq", since.seqSince)
      .order("sync_seq", { ascending: true })
      .limit(limit ?? 5000),
  ]);

  const style = await getGroupNameStyle(userId);
  let body = MULTISTATUS_OPEN;

  for (const row of (cRows as Array<{ id: string; updated_at: string }> | null) ?? []) {
    body += await buildContactResponse(userId, email, row.id, includeVcard);
  }
  for (const row of (gRows as Array<{ id: string; updated_at: string }> | null) ?? []) {
    body += await buildGroupResponse(userId, email, row.id, includeVcard, style);
  }
  for (const t of (tRows as Array<{ resource_type: string; resource_id: string }> | null) ?? []) {
    const href =
      t.resource_type === "group"
        ? groupHref(email, t.resource_id)
        : contactHref(email, t.resource_id);
    body +=
      `<D:response>` +
      `<D:href>${href}</D:href>` +
      `<D:status>HTTP/1.1 404 Not Found</D:status>` +
      `</D:response>`;
  }

  const newToken = buildSyncToken(userId, snap.updatedAt, snap.seq);
  body += `<D:sync-token>${xmlEscape(newToken)}</D:sync-token>`;
  body += MULTISTATUS_CLOSE;
  return davResponse(body);
}

export async function handleReport(
  request: Request,
  userId: string,
  email: string,
): Promise<Response> {
  const raw = await request.text();
  const lower = raw.toLowerCase();
  const includeVcard = lower.includes("address-data");

  if (lower.includes("sync-collection")) {
    return handleSyncCollection(raw, userId, email);
  }



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
    const style = await getGroupNameStyle(userId);
    for (const id of groupIds) {
      if (!owned.has(id)) continue;
      body += await buildGroupResponse(userId, email, id, includeVcard, style);
    }
  }
  body += MULTISTATUS_CLOSE;
  return davResponse(body);
}

// -----------------------------------------------------------------------------
// GET / HEAD on a single .vcf

function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  const norm = (v: string) => v.trim().replace(/^W\//i, "");
  const wanted = norm(etag);
  return header
    .split(",")
    .map((v) => norm(v))
    .some((v) => v === "*" || v === wanted);
}

export async function handleGet(
  request: Request,
  userId: string,
  email: string,
  path: string,
  method: "GET" | "HEAD",
): Promise<Response> {
  const ifNoneMatch = request.headers.get("if-none-match");
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
    const etag = groupETag(group.id, group.updated_at);
    if (matchesIfNoneMatch(ifNoneMatch, etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    const members = await fetchGroupMembers(group.id);
    const style = await getGroupNameStyle(userId);
    const displayName = await resolveGroupDisplayName(userId, group.id, group.name, style);
    const vcard = buildGroupVCard({
      uid: group.carddav_uid ?? `group-${group.id}`,
      name: displayName,
      memberContactIds: members,
      updatedAt: group.updated_at,
    });
    return new Response(method === "HEAD" ? null : vcard, {
      status: 200,
      headers: {
        "Content-Type": 'text/vcard; charset="utf-8"',
        ETag: etag,
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

  const etag = contactETag(owner.id, owner.updated_at as string);
  if (matchesIfNoneMatch(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const { row } = await getContactDecrypted(contactId);
  if (!row) return new Response("Not found", { status: 404 });
  const [phones, categories] = await Promise.all([
    fetchPhones(contactId),
    fetchCategoriesForContact(userId, contactId),
  ]);
  const vcard = contactToVCard(row, phones, categories);

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

// Reconcile a contact's group membership from the CATEGORIES: line the
// phone sent. Any category name that doesn't yet exist as a group is
// auto-created. Any group the contact belonged to but that CATEGORIES no
// longer lists is removed. Group→folder links follow via the sender_in_group
// filter row automatically since deletes/inserts flow through contact_group_members.
async function reconcileContactCategories(
  userId: string,
  contactId: string,
  categoryNames: string[],
): Promise<void> {
  const names = Array.from(
    new Set(categoryNames.map((n) => n.trim()).filter((n) => n.length > 0)),
  );

  // Load the user's current groups keyed by lowercased name for a
  // case-insensitive match on the phone's category strings.
  const { data: existingGroups } = await supabaseAdmin
    .from("contact_groups")
    .select("id,name")
    .eq("user_id", userId);
  const byName = new Map<string, string>();
  for (const g of (existingGroups ?? []) as Array<{ id: string; name: string }>) {
    byName.set(g.name.toLowerCase(), g.id);
  }

  const targetIds: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    const existingId = byName.get(key);
    if (existingId) {
      targetIds.push(existingId);
      continue;
    }
    // Create the group with a stable CardDAV UID so iOS sees it on
    // next PROPFIND.
    const uid =
      "group-" +
      (globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const { data: created, error } = await supabaseAdmin
      .from("contact_groups")
      .insert({ user_id: userId, name, color: "#6366f1", carddav_uid: uid })
      .select("id")
      .single();
    if (!error && created) {
      targetIds.push(created.id);
      byName.set(key, created.id);
    }
  }

  // Replace membership: delete then insert. RLS is via user_id filter.
  await supabaseAdmin
    .from("contact_group_members")
    .delete()
    .eq("contact_id", contactId)
    .eq("user_id", userId);
  if (targetIds.length > 0) {
    const rows = targetIds.map((group_id) => ({
      group_id,
      contact_id: contactId,
      user_id: userId,
    }));
    await supabaseAdmin.from("contact_group_members").insert(rows);
  }
}

// PUT for an Apple-style group vCard. Creates a contact_groups row (if
// missing) and sets its member list to exactly the MEMBER UIDs in the vCard.
async function handleGroupPut(
  request: Request,
  userId: string,
  email: string,
  path: string,
  parsed: NonNullable<ReturnType<typeof parseVCard>>,
): Promise<Response> {
  const groupId = extractGroupId(path);
  if (!groupId || !UUID_RE.test(groupId)) {
    return new Response("Bad Request", { status: 400 });
  }

  const { data: existing } = await supabaseAdmin
    .from("contact_groups")
    .select("id,updated_at,name,carddav_uid")
    .eq("id", groupId)
    .eq("user_id", userId)
    .maybeSingle();

  const ifMatch = request.headers.get("if-match");
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch === "*" && existing) return preconditionFailed();
  if (ifMatch && existing) {
    const current = groupETag(existing.id, existing.updated_at as string);
    const norm = (v: string) => v.trim().replace(/^W\//i, "");
    if (norm(ifMatch) !== norm(current)) return preconditionFailed();
  }
  if (ifMatch && !existing) return preconditionFailed();

  const name = (parsed.name ?? "").trim() || "Untitled group";
  const nowIso = new Date().toISOString();

  if (existing) {
    const { error } = await supabaseAdmin
      .from("contact_groups")
      .update({ name, updated_at: nowIso })
      .eq("id", groupId)
      .eq("user_id", userId);
    if (error) return new Response(error.message, { status: 500 });
  } else {
    const { error } = await supabaseAdmin.from("contact_groups").insert({
      id: groupId,
      user_id: userId,
      name,
      color: "#6366f1",
      carddav_uid: parsed.uid ?? `group-${groupId}`,
    });
    if (error) return new Response(error.message, { status: 500 });
  }

  // Set membership to exactly the parsed member UIDs (that the caller owns).
  const memberIds = parsed.memberUids;
  await supabaseAdmin
    .from("contact_group_members")
    .delete()
    .eq("group_id", groupId)
    .eq("user_id", userId);
  if (memberIds.length > 0) {
    const { data: owned } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("user_id", userId)
      .in("id", memberIds);
    const rows = ((owned as Array<{ id: string }> | null) ?? []).map((r) => ({
      group_id: groupId,
      contact_id: r.id,
      user_id: userId,
    }));
    if (rows.length > 0) {
      await supabaseAdmin.from("contact_group_members").insert(rows);
    }
  }

  return new Response(null, {
    status: existing ? 204 : 201,
    headers: {
      ETag: groupETag(groupId, nowIso),
      Location: groupHref(email, groupId),
    },
  });
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
  const body = await request.text();
  const parsed = parseVCard(body);
  if (!parsed) return new Response("Unparseable vCard", { status: 400 });

  // Group vCards (Apple X-ADDRESSBOOKSERVER-KIND:group or the group- URL
  // prefix) route to the group upsert path.
  if (extractGroupId(path) || parsed.isGroup) {
    return handleGroupPut(request, userId, email, path, parsed);
  }

  const contactId = extractContactId(path);
  if (!contactId || !UUID_RE.test(contactId)) {
    return new Response("Bad Request", { status: 400 });
  }

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

  // Snapshot the previous state BEFORE we touch anything so a bad iOS PUT
  // that wipes fields can be restored from the Contact drawer. iOS routinely
  // uploads partial vCards for single-field edits; even with the merge logic
  // below, the safety net is cheap and user-visible.
  if (existing) {
    await snapshotContact(userId, contactId, "carddav_put").catch(() => {
      // Non-fatal: never block the sync on snapshot bookkeeping.
    });
  }

  // Merge, don't replace. Only overwrite plaintext fields whose vCard
  // property actually appeared in this PUT — iOS sends partial vCards for
  // single-field edits and any unspecified field must survive.
  const present = parsed.presentFields;
  type ContactPatch = {
    user_id: string;
    email: string;
    source: string;
    updated_at: string;
    name?: string | null;
    company?: string | null;
    title?: string | null;
    website?: string | null;
    city?: string | null;
    region?: string | null;
    postal_code?: string | null;
    country?: string | null;
    linkedin?: string | null;
    twitter?: string | null;
  };
  const plaintextPatch: ContactPatch = {
    user_id: userId,
    email: emailForRow,
    source: existing?.source ?? "carddav",
    updated_at: nowIso,
  };
  if (present.has("FN")) plaintextPatch.name = parsed.name;
  if (present.has("ORG")) plaintextPatch.company = parsed.company;
  if (present.has("TITLE")) plaintextPatch.title = parsed.title;
  if (present.has("URL")) plaintextPatch.website = parsed.website;
  if (present.has("ADR")) {
    plaintextPatch.city = parsed.city;
    plaintextPatch.region = parsed.region;
    plaintextPatch.postal_code = parsed.postal_code;
    plaintextPatch.country = parsed.country;
  }
  if (present.has("LINKEDIN")) plaintextPatch.linkedin = parsed.linkedin;
  if (present.has("TWITTER")) plaintextPatch.twitter = parsed.twitter;

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

  // Encrypted fields. The RPC treats NULL as "leave unchanged" and "" as
  // "clear". Only send fields whose vCard property was actually present so
  // an iOS edit that omits NOTE/ADR/TEL doesn't erase the stored value.
  const encPatch: {
    contact_id: string;
    notes?: string | null;
    address_line1?: string | null;
    address_line2?: string | null;
    phone?: string | null;
  } = { contact_id: contactId };
  if (present.has("NOTE")) encPatch.notes = parsed.notes ?? "";
  if (present.has("ADR")) {
    encPatch.address_line1 = parsed.address_line1 ?? "";
    encPatch.address_line2 = parsed.address_line2 ?? "";
  }
  if (present.has("TEL")) {
    const primaryPhone =
      parsed.phones.find((p) => p.is_primary)?.number ?? parsed.phones[0]?.number ?? "";
    encPatch.phone = primaryPhone;
  }
  if (
    encPatch.notes !== undefined ||
    encPatch.address_line1 !== undefined ||
    encPatch.phone !== undefined
  ) {
    const encErr = await setContactEncryptedFields(encPatch);
    if (encErr.error) return new Response(encErr.error, { status: 500 });
  }

  // Replace-all phones — but only when TEL was actually present in the PUT.
  // Otherwise iOS's partial vCard would wipe every saved phone.
  if (present.has("TEL")) {
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
  }

  // CATEGORIES → contact_group_members reconciliation. Only when the vCard
  // actually included a CATEGORIES line — iOS omits it for most edits and
  // running it unconditionally erased group membership.
  if (present.has("CATEGORIES")) {
    await reconcileContactCategories(userId, contactId, parsed.categories);
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
  const groupId = extractGroupId(path);
  if (groupId) {
    const { data: existing } = await supabaseAdmin
      .from("contact_groups")
      .select("id,updated_at")
      .eq("id", groupId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!existing) return new Response(null, { status: 404 });
    const ifMatch = request.headers.get("if-match");
    if (ifMatch) {
      const current = groupETag(existing.id, existing.updated_at as string);
      const norm = (v: string) => v.trim().replace(/^W\//i, "");
      if (norm(ifMatch) !== norm(current)) return preconditionFailed();
    }
    // Membership rows and any sender_in_group folder_filter cascade
    // via ON DELETE (folder_filters clean-up is handled by app-side link
    // UI; a hard group delete just drops rules that referenced it).
    await supabaseAdmin
      .from("contact_group_members")
      .delete()
      .eq("group_id", groupId)
      .eq("user_id", userId);
    await supabaseAdmin
      .from("folder_filters")
      .delete()
      .eq("op", "sender_in_group")
      .eq("value", groupId);
    const { error } = await supabaseAdmin
      .from("contact_groups")
      .delete()
      .eq("id", groupId)
      .eq("user_id", userId);
    if (error) return new Response(error.message, { status: 500 });
    await insertTombstone(userId, "group", groupId);
    return new Response(null, { status: 204 });
  }

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
  await insertTombstone(userId, "contact", contactId);

  return new Response(null, { status: 204 });
}

