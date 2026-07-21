// Thread-scope rules (rules upgrade, task 6). The contracts protected:
//
//   * a run_on_threads folder routes an incoming message when ANY message
//     in the thread satisfies its rules (per-message evaluation — fields
//     are never mixed across messages),
//   * without run_on_threads, only the incoming message is evaluated —
//     existing folders keep exact message-scope behavior (gating),
//   * matched_via_thread reports when only a prior message matched, and
//     classifyByRules appends the thread note to the reason,
//   * exclude/veto rules always evaluate against the incoming message,
//   * priority ordering is shared across thread- and message-scoped
//     folders — a thread match never jumps the queue.

import { describe, it, expect } from "vitest";
import { matchByFilters, matchByFiltersOnThread, type EmailForFilter } from "./filter-engine";
import { classifyByRules } from "./classify";
import type { AccountContext } from "./account-context";
import type { Filter, Folder } from "./types";

function email(over: Partial<EmailForFilter> = {}): EmailForFilter {
  return {
    from_addr: "alice@example.com",
    from_name: "Alice",
    to_addrs: "me@example.com",
    subject: "Re: hello",
    body_text: "just a reply",
    has_attachment: false,
    ...over,
  };
}

function folder(over: Partial<Folder> = {}): Folder {
  return {
    id: over.id ?? "f1",
    name: over.name ?? "Default",
    gmail_label_id: null,
    ai_rule: null,
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

function filter(folder_id: string, field: string, op: string, value: string, id?: string): Filter {
  return { id: id ?? `${folder_id}-${field}-${value}`, folder_id, field, op, value };
}

// Thread: incoming reply (no keyword) + two prior messages, one carrying
// the "invoice" keyword the folder matches on.
const incoming = email({ subject: "Re: hello", body_text: "sounds good, thanks!" });
const priorPlain = email({ subject: "hello", body_text: "kicking off the thread" });
const priorInvoice = email({
  from_addr: "billing@stripe.com",
  from_name: "Stripe Billing",
  subject: "Your invoice #123",
  body_text: "invoice attached",
});
const thread = [priorPlain, priorInvoice];

describe("matchByFiltersOnThread", () => {
  const invoiceFilter = [filter("f-inv", "subject", "contains", "invoice")];

  it("routes the incoming message when only a prior thread message matches", () => {
    const f = folder({ id: "f-inv", name: "Invoices", run_on_threads: true });
    const m = matchByFiltersOnThread(incoming, thread, [f], invoiceFilter);
    expect(m).toMatchObject({ kind: "match", folder_id: "f-inv", matched_via_thread: true });
  });

  it("without run_on_threads the same thread does NOT route (gating)", () => {
    const f = folder({ id: "f-inv", name: "Invoices" });
    expect(matchByFiltersOnThread(incoming, thread, [f], invoiceFilter)).toBeNull();
    expect(matchByFilters(incoming, [f], invoiceFilter)).toBeNull();
  });

  it("a directly-matching incoming message reports matched_via_thread=false", () => {
    const f = folder({ id: "f-inv", name: "Invoices", run_on_threads: true });
    const m = matchByFiltersOnThread(priorInvoice, thread, [f], invoiceFilter);
    expect(m).toMatchObject({ kind: "match", matched_via_thread: false });
  });

  it("filter_logic 'all' evaluates per message — fields never mix across messages", () => {
    const f = folder({ id: "f-inv", name: "Invoices", run_on_threads: true, filter_logic: "all" });
    // subject contains "invoice" AND from contains "stripe": true for
    // priorInvoice as a single message.
    const fs = [
      filter("f-inv", "subject", "contains", "invoice"),
      filter("f-inv", "from", "contains", "stripe"),
    ];
    expect(matchByFiltersOnThread(incoming, thread, [f], fs)).toMatchObject({ kind: "match" });
    // subject "invoice" AND from "alice": no single message has both, even
    // though the thread as a whole contains each somewhere.
    const mixed = [
      filter("f-inv", "subject", "contains", "invoice"),
      filter("f-inv", "from", "contains", "alice"),
    ];
    expect(matchByFiltersOnThread(incoming, thread, [f], mixed)).toBeNull();
  });

  it("filter trees evaluate across the thread too", () => {
    const f = folder({
      id: "f-inv",
      name: "Invoices",
      run_on_threads: true,
      filter_tree: { type: "cond", field: "domain", op: "equals", value: "stripe.com" },
    });
    const m = matchByFiltersOnThread(incoming, thread, [f], []);
    expect(m).toMatchObject({ kind: "match", tree_used: true, matched_via_thread: true });
  });

  it("exclude rules veto on the INCOMING message only", () => {
    const f = folder({ id: "f-inv", name: "Invoices", run_on_threads: true });
    // Veto fires: the incoming body contains "thanks".
    const vetoed = matchByFiltersOnThread(
      incoming,
      thread,
      [f],
      [...invoiceFilter, filter("f-inv", "body", "not_contains", "thanks")],
    );
    expect(vetoed).toMatchObject({ kind: "excluded", folder_id: "f-inv" });
    // A veto keyword that only appears in a PRIOR message does not fire.
    const notVetoed = matchByFiltersOnThread(
      incoming,
      thread,
      [f],
      [...invoiceFilter, filter("f-inv", "body", "not_contains", "kicking off")],
    );
    expect(notVetoed).toMatchObject({ kind: "match" });
  });

  it("priority ordering is shared: a higher-priority message-scope match beats a thread match", () => {
    const threadFolder = folder({
      id: "f-inv",
      name: "Invoices",
      run_on_threads: true,
      priority: 1,
    });
    const directFolder = folder({ id: "f-replies", name: "Replies", priority: 5 });
    const fs = [...invoiceFilter, filter("f-replies", "subject", "starts_with", "re:")];
    const m = matchByFiltersOnThread(incoming, thread, [threadFolder, directFolder], fs);
    expect(m).toMatchObject({ kind: "match", folder_id: "f-replies" });
    if (m?.kind === "match") {
      expect(m.all_matched_folder_ids).toEqual(["f-replies", "f-inv"]);
    }
  });
});

describe("classifyByRules with thread context", () => {
  function context(folders: Folder[], filters: Filter[]): AccountContext {
    return {
      folders,
      filters,
      overrides: [],
      overrideExceptions: [],
      enrichedFolders: [],
      calendarGuardEnabled: false,
      calendarContacts: new Set(),
      accountEmail: "me@example.com",
      senderGroups: new Map(),
    } as unknown as AccountContext;
  }
  const parsed = {
    from_addr: incoming.from_addr,
    from_name: incoming.from_name,
    to_addrs: incoming.to_addrs,
    subject: incoming.subject,
    snippet: "",
    body_text: incoming.body_text,
    body_html: "",
    has_attachment: false,
    received_at: "2026-07-21T00:00:00Z",
    raw_labels: ["INBOX"],
  };

  it("routes via thread context and annotates the reason", () => {
    const f = folder({ id: "f-inv", name: "Invoices", run_on_threads: true });
    const fs = [filter("f-inv", "subject", "contains", "invoice")];
    const r = classifyByRules(parsed, context([f], fs), { threadEmails: thread });
    expect(r.folder_id).toBe("f-inv");
    expect(r.classified_by).toBe("filter");
    expect(r.classification_reason).toContain("matched an earlier message in this thread");
  });

  it("without threadEmails (or without the flag) behavior is unchanged", () => {
    const flagged = folder({ id: "f-inv", name: "Invoices", run_on_threads: true });
    const fs = [filter("f-inv", "subject", "contains", "invoice")];
    expect(classifyByRules(parsed, context([flagged], fs)).folder_id).toBeNull();

    const unflagged = folder({ id: "f-inv", name: "Invoices" });
    expect(
      classifyByRules(parsed, context([unflagged], fs), { threadEmails: thread }).folder_id,
    ).toBeNull();
  });
});
