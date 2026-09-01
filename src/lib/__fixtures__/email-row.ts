// Test-only builders for the "email content" and "folder rule" shapes that
// the sync/classify pipeline passes around, generalized from the near-
// identical `folder()` / `filter()` / `email()` helpers that sync-classify,
// sync-catchup, filter-engine, and ingest-classify tests each hand-rolled.
//
// makeEmailRow returns the superset of email-content fields those tests
// use (from/to/subject/body plus received_at + raw_labels); callers whose
// target type is narrower (e.g. EmailForFilter, IngestCandidate) can pass
// its result straight through — the extra fields are simply ignored by
// TypeScript's structural typing. Callers whose target type is a superset
// (e.g. the parsed-Gmail-message shape) spread it and layer their own
// extra fields on top.
//
// Lives in __fixtures__ so it is excluded from the `src/**/*.test.ts` glob
// and never ships: only test files import it.
import type { Filter, Folder } from "../sync/types";

export type EmailRowFields = {
  from_addr: string;
  from_name: string;
  to_addrs: string;
  cc?: string;
  list_id?: string;
  in_reply_to?: string;
  subject: string;
  snippet: string;
  body_text: string;
  body_html: string;
  has_attachment: boolean;
  received_at: string;
  raw_labels: string[] | null;
};

export function makeEmailRow(over: Partial<EmailRowFields> = {}): EmailRowFields {
  return {
    from_addr: over.from_addr ?? "sender@example.com",
    from_name: over.from_name ?? "",
    to_addrs: over.to_addrs ?? "me@example.com",
    cc: over.cc,
    list_id: over.list_id,
    in_reply_to: over.in_reply_to,
    subject: over.subject ?? "",
    snippet: over.snippet ?? "",
    body_text: over.body_text ?? "",
    body_html: over.body_html ?? "",
    has_attachment: over.has_attachment ?? false,
    received_at: over.received_at ?? new Date().toISOString(),
    raw_labels: over.raw_labels ?? ["INBOX"],
  };
}

export function makeFolder(over: Partial<Folder> = {}): Folder {
  // Spread, not per-field `??`: an EXPLICIT null override (e.g.
  // `ai_rule: null`, meaning "no AI for this folder") must win over the
  // default, and optional Folder fields (processing_enabled,
  // mark_read_mode) must pass through instead of being dropped.
  return {
    id: "f-default",
    name: "Default",
    gmail_label_id: null,
    ai_rule: "route mail here",
    learned_profile: null,
    last_learned_at: null,
    auto_archive: false,
    auto_mark_read: false,
    auto_star: false,
    hide_from_inbox: false,
    skip_ai: false,
    priority: 0,
    gmail_account_id: "acc-1",
    filter_logic: "any",
    filter_tree: null,
    forward_to: null,
    min_ai_confidence: 0,
    snooze_hours: 0,
    overrides_inbox_override: false,
    is_cold_email: false,
    surface_ai_rule: null,
    surface_names: null,
    ...over,
  };
}

export function makeRule(
  folder_id: string,
  field: string,
  op: string,
  value: string,
  id?: string,
): Filter {
  return { id: id ?? `${folder_id}-${field}-${value}`, folder_id, field, op, value };
}
