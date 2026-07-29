// Pure mapping from a parsed Gmail message to the email upsert payload.
//
// Deliberately separate from encrypted-writer: that module performs the DB
// write and is mocked wholesale in several test suites, while this is a pure
// function every one of those suites wants the REAL version of — a hand-faked
// builder in each mock would drift from the real payload, which is exactly the
// class of bug this consolidation removes.
import type { UpsertEmailInput } from "./encrypted-writer";

/** The subset of parseMessage() output the email upsert reads. */
export type ParsedForUpsert = {
  gmail_message_id: string;
  thread_id: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_addrs: string | null;
  cc?: string | null;
  list_id?: string | null;
  in_reply_to?: string | null;
  reply_to_addr?: string | null;
  origin_addr?: string | null;
  is_forwarded?: boolean;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  received_at: string | null;
  is_read: boolean;
  has_attachment: boolean;
  raw_labels: string[] | null;
};

/**
 * Build the email upsert payload from a parsed Gmail message.
 *
 * This 23-field mapping was spelled out at five call sites (the live classify
 * path, both folder-learn ingests, and the two Gmail search/scan ingests),
 * which is how they drifted apart on which fields they bothered to set.
 *
 * Defaults are the BACKFILL shape used by the four ingest paths: headers and
 * processing timestamps null, and archived derived from the absence of the
 * INBOX label. The live path passes real values for those as `overrides`,
 * which are spread last and win.
 */
export function toEmailUpsert(
  p: ParsedForUpsert,
  fields: {
    user_id: string;
    gmail_account_id: string;
    classified_by: string;
  } & Partial<UpsertEmailInput>,
): UpsertEmailInput {
  return {
    gmail_message_id: p.gmail_message_id,
    thread_id: p.thread_id,
    from_addr: p.from_addr,
    from_name: p.from_name,
    to_addrs: p.to_addrs,
    cc: p.cc ?? null,
    list_id: p.list_id ?? null,
    in_reply_to: p.in_reply_to ?? null,
    reply_to_addr: p.reply_to_addr ?? null,
    origin_addr: p.origin_addr ?? null,
    is_forwarded: p.is_forwarded ?? false,
    subject: p.subject,
    snippet: p.snippet,
    body_text: p.body_text,
    body_html: p.body_html,
    received_at: p.received_at,
    is_read: p.is_read,
    is_archived: !(p.raw_labels ?? []).includes("INBOX"),
    has_attachment: p.has_attachment,
    raw_labels: p.raw_labels,
    processed_at: null,
    published_at_ms: null,
    ...fields,
  };
}
