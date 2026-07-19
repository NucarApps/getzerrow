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

/**
 * Read the requested prop names out of a PROPFIND body so we only include
 * what iOS asked for. Missing body means "return everything" per RFC 4918.
 */
export function parseRequestedProps(body: string): Set<string> {
  const out = new Set<string>();
  if (!body || body.length === 0) return out;
  // Grab tag names inside <D:prop> or <prop>. We just need local names.
  const propBlockMatch = body.match(/<\w*:?prop[^>]*>([\s\S]*?)<\/\w*:?prop>/i);
  if (!propBlockMatch) return out;
  const inner = propBlockMatch[1];
  const tagRe = /<(\w+:)?([\w-]+)[^/]*\/>|<(\w+:)?([\w-]+)[^>]*>[\s\S]*?<\/\3?[\w-]+>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(inner))) {
    const name = (m[2] ?? m[4] ?? "").toLowerCase();
    if (name) out.add(name);
  }
  return out;
}

/** Read all <D:href> values from an addressbook-multiget body. */
export function parseMultigetHrefs(body: string): string[] {
  const out: string[] = [];
  const re = /<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const href = m[1].trim();
    if (href) out.push(href);
  }
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
  const rawLimit = limitMatch ? Number.parseInt(limitMatch[1].trim(), 10) : NaN;
  return {
    syncToken: tokenMatch ? tokenMatch[1].trim() : "",
    syncLevel: levelMatch ? levelMatch[1].trim() : "1",
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null,
  };
}
