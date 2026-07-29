// Who REALLY sent a message that arrived through an auto-forward.
//
// When a mailbox auto-forwards (e.g. an ex-employee's account still relaying
// vendor mail), Gmail's `From` header is the forwarder, not the vendor. Every
// sender/domain rule then targets the forwarder, which is useless: the user
// wants "everything from Manheim", not "everything Ken relayed".
//
// Pure logic (no Gmail API, no DB) so the precedence is testable in isolation.
import { emailDomain } from "../company-domains";


/** Header lookup: name (case-insensitive) -> raw value, "" when absent. */
export type HeaderLookup = (name: string) => string;

export type OriginSender = {
  /** Reply-To address, when present. */
  reply_to_addr: string | null;
  /** Best guess at the true sender. Null when it equals `From`. */
  origin_addr: string | null;
  /** Display name that goes with `origin_addr`, when the header carried one. */
  origin_name: string | null;
  /** True when `origin_addr` is set and differs from the From address. */
  is_forwarded: boolean;
};

/** Minimal address extractor. Kept local (rather than importing the Gmail
 * parser) so this module stays pure and free of server-only imports. */
function addrOf(raw: string): { addr: string; name: string } {
  const s = (raw ?? "").trim();
  if (!s) return { addr: "", name: "" };
  const angle = s.match(/<([^>]*)>/);
  if (angle) {
    const name = s
      .slice(0, s.indexOf("<"))
      .trim()
      .replace(/^"(.*)"$/s, "$1")
      .trim();
    return { addr: angle[1].trim().toLowerCase(), name };
  }
  const token = s.split(/\s+/).find((t) => t.includes("@"));
  if (token) {
    const addr = token.replace(/^[<(]+/, "").replace(/[>),;]+$/, "");
    return { addr: addr.toLowerCase(), name: s === token ? "" : s.replace(token, "").trim() };
  }
  return { addr: "", name: "" };
}


/**
 * Derive the originating sender from a message's headers.
 *
 * Precedence, highest first:
 *  1. `X-Original-From` / `X-Original-Sender` — explicit relay annotations.
 *  2. `Reply-To`, when its domain differs from the From domain (the classic
 *     "forwarded by a mailbox, replies go to the real sender" shape).
 *  3. `X-Forwarded-For` — first address in the list.
 *  4. `Sender` / `Return-Path`, when they differ from From.
 *  5. Nothing — the From address stands on its own.
 */
export function deriveOriginSender(h: HeaderLookup): OriginSender {
  const from = addrOf(h("from"));
  const replyToRaw = h("reply-to");
  const replyTo = replyToRaw ? addrOf(replyToRaw) : null;
  const fromDomain = from.addr ? emailDomain(from.addr) : null;

  const candidates: Array<{ addr: string; name: string }> = [];

  for (const name of ["x-original-from", "x-original-sender"]) {
    const v = h(name);
    if (v) candidates.push(addrOf(v));
  }

  if (replyTo?.addr) {
    const replyDomain = emailDomain(replyTo.addr);
    // Only treat Reply-To as the origin when it points at a DIFFERENT
    // organisation. A same-domain Reply-To is just a routing alias.
    if (replyDomain && fromDomain && replyDomain !== fromDomain) candidates.push(replyTo);
  }

  const xff = h("x-forwarded-for");
  if (xff) {
    // "forwarder@a.com original@b.com" — the ORIGINAL address is the last one.
    const parts = xff
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter((t) => t.includes("@"));
    const last = parts[parts.length - 1];
    if (last) candidates.push(addrOf(last));
  }

  for (const name of ["sender", "return-path"]) {
    const v = h(name);
    if (v) candidates.push(addrOf(v));
  }

  const origin = candidates.find(
    (c) => c.addr && c.addr !== from.addr && emailDomain(c.addr) !== fromDomain,
  );

  return {
    reply_to_addr: replyTo?.addr || null,
    origin_addr: origin?.addr ?? null,
    origin_name: origin?.name || null,
    is_forwarded: !!origin?.addr,
  };
}

/** The sender a rule should match on: the true origin when the message was
 * forwarded, otherwise the From address. Keeps `origin_*` rules working for
 * direct mail and for rows written before origin tracking existed. */
export function effectiveSender(email: {
  from_addr?: string | null;
  origin_addr?: string | null;
}): string {
  return (email.origin_addr || email.from_addr || "").toLowerCase();
}
