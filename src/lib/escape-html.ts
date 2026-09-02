/**
 * Escape text for interpolation into HTML we generate ourselves (card emails,
 * folder-summary digests, OG images).
 *
 * Both quote characters are escaped along with `& < >`, so the result is
 * safe in text content and inside an attribute value whichever quote
 * delimits it. (One of the two previous copies escaped neither; a later one
 * escaped only `"`, which quietly limited it to double-quoted attributes.)
 *
 * Deliberately NOT idempotent: escaping twice yields `&amp;amp;`, because a
 * `&` in the input is data and an escaper that tried to recognise
 * already-escaped entities would let a crafted `&lt;` through as markup.
 * Escape once, at the point of interpolation.
 *
 * Note: XML/vCard escaping is a different grammar — see carddav/xml.ts.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
