// Rule simulator (rules upgrade, task 10). Contracts protected:
//
//   * deterministic: same emails + same draft = same output, in input
//     order — and NO AI anywhere in the loop,
//   * the draft overlays the real config: editing an existing folder
//     replaces its row + filters; a new draft competes under normal
//     priority rules (a higher-priority existing folder still wins),
//   * emails already in the draft folder are not reported as moves;
//     exclude rules veto into would_exclude,
//   * list output is capped but counts cover everything,
//   * 1k emails simulate in < 300ms.

import { describe, it, expect } from "vitest";
import { simulateAgainstEmails, SIMULATION_LIST_CAP, type SimEmail } from "./simulate-rule";
import type { Filter, Folder } from "./types";

function folder(over: Partial<Folder> & { id: string; name: string }): Folder {
  return {
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

function email(id: string, over: Partial<SimEmail> = {}): SimEmail {
  return {
    id,
    current_folder_id: null,
    from_addr: "alice@example.com",
    from_name: "Alice",
    to_addrs: "me@example.com",
    subject: "hello",
    body_text: "plain body",
    has_attachment: false,
    ...over,
  };
}

const flt = (folder_id: string, field: string, op: string, value: string, id = ""): Filter => ({
  id: id || `${folder_id}-${field}-${value}`,
  folder_id,
  field,
  op,
  value,
});

const DRAFT = {
  folder: folder({ id: "draft-1", name: "Invoices" }),
  filters: [flt("draft-1", "subject", "contains", "invoice")],
};

describe("simulateAgainstEmails", () => {
  it("reports moves, skips already-filed mail, and is deterministic", () => {
    const emails = [
      email("e1", { subject: "Your invoice #1" }),
      email("e2", { subject: "lunch?" }),
      email("e3", { subject: "invoice #2", current_folder_id: "draft-1" }),
    ];
    const run = () => simulateAgainstEmails(emails, DRAFT, { folders: [], filters: [] });
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    expect(a.moves).toBe(1);
    expect(a.would_route.map((h) => h.email_id)).toEqual(["e1"]);
    expect(a.would_route[0].matched_leaves).toEqual([
      { field: "subject", op: "contains", value: "invoice" },
    ]);
    expect(a.no_change).toBe(2);
    expect(a.scanned).toBe(3);
  });

  it("exclude rules veto into would_exclude with the vetoing leaf", () => {
    const draft = {
      folder: DRAFT.folder,
      filters: [...DRAFT.filters, flt("draft-1", "subject", "not_contains", "refund")],
    };
    const r = simulateAgainstEmails([email("e1", { subject: "invoice refund" })], draft, {
      folders: [],
      filters: [],
    });
    expect(r.excluded).toBe(1);
    expect(r.moves).toBe(0);
    expect(r.would_exclude[0].matched_leaves[0].value).toBe("refund");
  });

  it("editing an existing folder replaces its config instead of duplicating it", () => {
    const existingFolder = folder({ id: "draft-1", name: "Invoices (old)" });
    const existingFilters = [flt("draft-1", "subject", "contains", "totally-different")];
    const r = simulateAgainstEmails([email("e1", { subject: "totally-different topic" })], DRAFT, {
      folders: [existingFolder],
      filters: existingFilters,
    });
    // Old filter is replaced by the draft's — the old match must not fire.
    expect(r.moves).toBe(0);
  });

  it("a higher-priority existing folder still wins over the draft", () => {
    const rival = folder({ id: "f-rival", name: "Rival", priority: 10 });
    const rivalFilter = flt("f-rival", "subject", "contains", "invoice");
    const r = simulateAgainstEmails([email("e1", { subject: "invoice #9" })], DRAFT, {
      folders: [rival],
      filters: [rivalFilter],
    });
    expect(r.moves).toBe(0);
    expect(r.no_change).toBe(1);
  });

  it("caps the returned lists but counts everything", () => {
    const emails = Array.from({ length: SIMULATION_LIST_CAP + 50 }, (_, i) =>
      email(`e${i}`, { subject: `invoice #${i}` }),
    );
    const r = simulateAgainstEmails(emails, DRAFT, { folders: [], filters: [] });
    expect(r.moves).toBe(SIMULATION_LIST_CAP + 50);
    expect(r.would_route).toHaveLength(SIMULATION_LIST_CAP);
  });

  it("simulates 1k emails against a tree draft in under 300ms", () => {
    const draft = {
      folder: folder({
        id: "draft-t",
        name: "Tree",
        filter_tree: {
          type: "group",
          op: "or",
          children: [
            { type: "cond", field: "domain", op: "equals", value: "stripe.com" },
            {
              type: "group",
              op: "and",
              children: [
                { type: "cond", field: "subject", op: "contains", value: "invoice" },
                { type: "cond", field: "body", op: "not_contains", value: "refund" },
              ],
            },
          ],
        },
      }),
      filters: [],
    };
    const emails = Array.from({ length: 1000 }, (_, i) =>
      email(`e${i}`, {
        from_addr: i % 3 === 0 ? "billing@stripe.com" : `user${i}@example.com`,
        subject: i % 2 === 0 ? `invoice #${i}` : `hello ${i}`,
        body_text: i % 5 === 0 ? "refund attached" : "regular body text",
      }),
    );
    const existing = {
      folders: [folder({ id: "f-x", name: "X" })],
      filters: [flt("f-x", "from", "contains", "noreply")],
    };
    const start = performance.now();
    const r = simulateAgainstEmails(emails, draft, existing);
    const elapsed = performance.now() - start;
    expect(r.scanned).toBe(1000);
    expect(r.moves).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(300);
  });
});
