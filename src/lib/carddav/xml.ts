// Tiny XML helpers for the CardDAV responses iOS actually reads.
// We hand-render — no XML lib needed and the output stays predictable.

export function xmlEscape(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export const MULTISTATUS_OPEN =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">';
export const MULTISTATUS_CLOSE = "</D:multistatus>";

export function responseBlock(href: string, propsXml: string, status = "HTTP/1.1 200 OK"): string {
  return (
    `<D:response>` +
    `<D:href>${xmlEscape(href)}</D:href>` +
    `<D:propstat>` +
    `<D:prop>${propsXml}</D:prop>` +
    `<D:status>${status}</D:status>` +
    `</D:propstat>` +
    `</D:response>`
  );
}

/** A bare `<D:response>` carrying a status instead of a propstat — what
 * RFC 6352 §8.7 wants for a multiget href that resolves to nothing, and what
 * RFC 6578 wants for a resource that has been deleted since the last sync.
 * The href is escaped because it can come straight off the request body. */
export function statusResponseBlock(
  href: string,
  status = "HTTP/1.1 404 Not Found",
  extraXml = "",
): string {
  return (
    `<D:response>` +
    `<D:href>${xmlEscape(href)}</D:href>` +
    `<D:status>${status}</D:status>` +
    extraXml +
    `</D:response>`
  );
}

// Wrap the standard PROPFIND response envelope + headers.
export function davResponse(body: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 207,
    headers: {
      "Content-Type": 'application/xml; charset="utf-8"',
      DAV: "1, 3, addressbook",
      ...extraHeaders,
    },
  });
}

/** Read all <D:href> values from an addressbook-multiget body. */
export function parseMultigetHrefs(body: string): string[] {
  const out: string[] = [];
  const re = /<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const href = m[1]?.trim();
    if (href) out.push(href);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PROPFIND prop subsets (RFC 4918 §9.1)

export const NS_DAV = "DAV:";
export const NS_CARDDAV = "urn:ietf:params:xml:ns:carddav";
export const NS_CALENDARSERVER = "http://calendarserver.org/ns/";

/** A property this server can render, tagged with the namespace it lives in
 * so a request can be matched by namespace rather than by whichever prefix
 * the client happened to bind. */
export type PropSpec = { ns: string; name: string; xml: string };

/** A property the client asked for, resolved to (namespace, local name). */
export type RequestedProp = { ns: string; name: string };

const NAME = "[A-Za-z_][A-Za-z0-9_.-]*";
// `prop` but not `prop-filter` / `propfind` / `propstat`.
const PROP_ELEMENT = new RegExp(
  `<(?:${NAME}:)?prop(?![-A-Za-z0-9_.])[^>]*>([\\s\\S]*?)</(?:${NAME}:)?prop\\s*>`,
  "i",
);
const CHILD_ELEMENT = new RegExp(`<(${NAME}:)?(${NAME})(?:\\s[^>]*?)?/?>`, "g");

/** prefix → namespace URI, from every xmlns declaration in the document. The
 * body is small and hand-written by clients; a full parse would buy nothing
 * over collecting the declarations, since nobody rebinds a prefix mid-body. */
function namespaceBindings(body: string): Map<string, string> {
  const out = new Map<string, string>([["", ""]]);
  for (const m of body.matchAll(new RegExp(`xmlns:(${NAME})\\s*=\\s*"([^"]*)"`, "g"))) {
    out.set(m[1]!, m[2]!);
  }
  const dflt = body.match(/xmlns\s*=\s*"([^"]*)"/);
  if (dflt?.[1]) out.set("", dflt[1]);
  return out;
}

/**
 * The `<D:prop>` subset a PROPFIND asked for, or null when the request did
 * not name one — an absent body, `allprop`, `propname`, or XML we cannot read.
 * Null means "render everything", which is what this server did for every
 * request before prop subsets were honoured, so a client that sends something
 * unexpected is never worse off than it was.
 */
export function parseRequestedProps(body: string | null | undefined): RequestedProp[] | null {
  if (!body) return null;
  const inner = body.match(PROP_ELEMENT)?.[1];
  if (!inner) return null;
  const ns = namespaceBindings(body);
  const out: RequestedProp[] = [];
  for (const m of inner.matchAll(CHILD_ELEMENT)) {
    const prefix = (m[1] ?? "").replace(/:$/, "");
    out.push({ ns: ns.get(prefix) ?? prefix, name: m[2]! });
  }
  // An empty `<D:prop/>` asks for nothing at all; treat it as unreadable
  // rather than answering with an empty response block.
  return out.length > 0 ? out : null;
}

/** Re-declare the namespace inline: the multistatus envelope only binds the
 * three prefixes this server writes, and a 404 propstat has to echo the
 * client's property in the client's own namespace. */
function emptyPropElement(p: RequestedProp): string {
  if (!p.ns) return `<${p.name}/>`;
  return `<x:${p.name} xmlns:x="${xmlEscape(p.ns)}"/>`;
}

function propstat(propsXml: string, status: string): string {
  return `<D:propstat><D:prop>${propsXml}</D:prop><D:status>${status}</D:status></D:propstat>`;
}

/**
 * One `<D:response>` for a resource, honouring the requested prop subset:
 * the props we have in a 200 propstat and the ones we do not in a 404
 * propstat. With `requested` null every available prop is returned in a
 * single 200 propstat.
 */
export function propfindResponseBlock(
  href: string,
  available: PropSpec[],
  requested: RequestedProp[] | null,
): string {
  if (!requested) return responseBlock(href, available.map((p) => p.xml).join(""));
  const found: string[] = [];
  const missing: string[] = [];
  for (const want of requested) {
    const hit = available.find((p) => p.ns === want.ns && p.name === want.name);
    if (hit) found.push(hit.xml);
    else missing.push(emptyPropElement(want));
  }
  let out = `<D:response><D:href>${xmlEscape(href)}</D:href>`;
  if (found.length > 0) out += propstat(found.join(""), "HTTP/1.1 200 OK");
  if (missing.length > 0) out += propstat(missing.join(""), "HTTP/1.1 404 Not Found");
  out += `</D:response>`;
  return out;
}

/**
 * Parse an RFC 6578 `sync-collection` REPORT body. Missing / empty token
 * means "initial sync". `limit` is optional (iOS rarely sends one).
 */
export function parseSyncCollection(body: string): {
  syncToken: string;
  syncLevel: string;
  limit: number | null;
} {
  const tokenMatch = body.match(/<(?:\w+:)?sync-token[^>]*>([\s\S]*?)<\/(?:\w+:)?sync-token>/i);
  const levelMatch = body.match(/<(?:\w+:)?sync-level[^>]*>([\s\S]*?)<\/(?:\w+:)?sync-level>/i);
  const limitMatch = body.match(/<(?:\w+:)?nresults[^>]*>([\s\S]*?)<\/(?:\w+:)?nresults>/i);
  const rawLimit = Number.parseInt(limitMatch?.[1]?.trim() ?? "", 10);
  return {
    syncToken: tokenMatch?.[1]?.trim() ?? "",
    syncLevel: levelMatch?.[1]?.trim() ?? "1",
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null,
  };
}
