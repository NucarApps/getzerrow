/**
 * base64url encoding, the form the Gmail API expects for `messages.send`
 * and `messages.insert` raw payloads (RFC 4648 §5: `+` → `-`, `/` → `_`,
 * padding stripped).
 *
 * Collected here because the same five-line transform was inlined at five
 * call sites across gmail.server.ts and cards.server.ts.
 */
export function toBase64Url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
