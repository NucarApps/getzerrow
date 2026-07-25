/**
 * Escape text for interpolation into HTML we generate ourselves (card emails,
 * folder-summary digests, OG images).
 *
 * `"` is escaped along with `& < >` so the same helper is safe inside an
 * attribute value, not just in text content. One of the two previous copies
 * omitted it.
 *
 * Note: XML/vCard escaping is a different grammar — see carddav/xml.ts.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
