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
  /** Display name of the relaying mailbox/group, for "X via Y" mail. */
  forwarder_name: string | null;
  /** True when the message reached the mailbox through a relay/forward. */
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
    return { addr: (angle[1] ?? "").trim().toLowerCase(), name };
  }
  const token = s.split(/\s+/).find((t) => t.includes("@"));
  if (token) {
    const addr = token.replace(/^[<(]+/, "").replace(/[>),;]+$/, "");
    return { addr: addr.toLowerCase(), name: s === token ? "" : s.replace(token, "").trim() };
  }
  return { addr: "", name: "" };
}

/**
 * Split a Google-style relay display name: `"Manheim" via Old User Ken Connor`
 * becomes `{ originName: "Manheim", forwarderName: "Old User Ken Connor" }`.
 *
 * Google Groups and Workspace routing rewrite `From` for DMARC, so the only
 * trace of the real sender in the visible header is this display name.
 */
export function parseViaDisplayName(
  displayName: string | null | undefined,
): { originName: string; forwarderName: string } | null {
  const raw = (displayName ?? "")
    .trim()
    .replace(/^"(.*)"$/s, "$1")
    .trim();
  if (!raw) return null;
  const m = raw.match(/^(.*\S)\s+via\s+(\S.*)$/i);
  const [, rawOrigin, rawForwarder] = m ?? [];
  if (!rawOrigin || !rawForwarder) return null;
  const originName = rawOrigin.replace(/^"(.*)"$/s, "$1").trim();
  const forwarderName = rawForwarder.replace(/^"(.*)"$/s, "$1").trim();
  if (!originName || !forwarderName) return null;
  return { originName, forwarderName };
}

/**
 * Derive the originating sender from a message's headers.
 *
 * Precedence, highest first:
 *  1. `X-Google-Original-From` — Gmail's DMARC rewrite of a relayed message.
 *     This is the shape Google Groups and Workspace routing produce, where
 *     `From` becomes `"Vendor" via Old User <exemployee@company.com>`.
 *  2. `X-Original-From` / `X-Original-Sender` — explicit relay annotations.
 *  3. `Reply-To`, when its domain differs from the From domain (the classic
 *     "forwarded by a mailbox, replies go to the real sender" shape).
 *  4. `X-Forwarded-For` — last address in the list.
 *  5. `Sender` / `Return-Path`, when they differ from From.
 *  6. Nothing addressable. When the message is still clearly relayed (a
 *     `List-Id` plus an "X via Y" display name), it is flagged as forwarded
 *     with the names we could recover, so the UI never pretends the relaying
 *     mailbox wrote the mail.
 */
export function deriveOriginSender(h: HeaderLookup): OriginSender {
  const fromRaw = h("from");
  const from = addrOf(fromRaw);
  const replyToRaw = h("reply-to");
  const replyTo = replyToRaw ? addrOf(replyToRaw) : null;
  const fromDomain = from.addr ? emailDomain(from.addr) : null;

  const candidates: Array<{ addr: string; name: string }> = [];

  for (const name of ["x-google-original-from", "x-original-from", "x-original-sender"]) {
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

  // Relay detection from the visible header, independent of any address we
  // recovered: mail that arrived through a group/alias carries a List-Id and
  // Google's "X via Y" display name.
  const via = parseViaDisplayName(from.name);
  const relayed = !!via && (!!h("list-id") || !!h("x-google-original-from") || !!h("sender"));

  return {
    reply_to_addr: replyTo?.addr || null,
    origin_addr: origin?.addr ?? null,
    origin_name: origin?.name || via?.originName || null,
    forwarder_name: via?.forwarderName || null,
    is_forwarded: !!origin?.addr || relayed,
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
