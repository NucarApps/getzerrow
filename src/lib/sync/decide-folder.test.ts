// THE precedence ladder, locked rung by rung.
//
// decideFolder is the ONE place that answers "which folder does this email
// belong in". This file is the rung SPEC: one describe per rung of the
// ladder documented at the top of decide-folder.ts, so a change that
// reorders precedence fails here rather than silently misfiling mail.
//
// Two neighbouring suites deliberately do NOT repeat these cases:
//   * __fixtures__/folder-scenarios.ts is the cross-decider table — the
//     same mailbox run through catchup / the v2 engine / the ingest
//     classifier and compared against this ladder as the oracle.
//   * classify.test.ts covers only what classifyParsedEmail adds on top:
//     the AI hand-off and the surface-to-inbox pass.
import { describe, it, expect } from "vitest";
import { decideFolder, type DecisionTrigger } from "./decide-folder";
import type { ParsedEmailForClassify } from "./classify";
import { makeAccountContext } from "./__fixtures__/account-context";
import { makeEmailRow, makeFolder, makeRule } from "@/lib/__fixtures__/email-row";

const folder = makeFolder;
const filter = makeRule;
const context = makeAccountContext;

const parsed: ParsedEmailForClassify = makeEmailRow({
  from_addr: "billing@stripe.com",
  from_name: "Stripe",
  to_addrs: "me@example.com",
  subject: "Your invoice is ready",
  body_text: "invoice attached",
  received_at: "2026-07-21T00:00:00Z",
});

const invoices = folder({
  id: "f-inv",
  name: "Invoices",
  gmail_label_id: "Label_9",
  ai_rule: null,
});
const invoiceFilter = filter("f-inv", "subject", "contains", "invoice");
const triggers: DecisionTrigger[] = ["arrival", "backfill", "rescue", "reanalyze", "label_change"];

describe("rung 1 — a paused folder is never a destination", () => {
  it("holds on every trigger, even when the folder's Gmail label is the one that fired", () => {
    const paused = folder({ ...invoices, processing_enabled: false });
    for (const trigger of triggers) {
      const r = decideFolder(parsed, context({ folders: [paused], filters: [invoiceFilter] }), {
        trigger,
        labeledFolderId: paused.id,
      });
      expect(r.folder_id, `trigger=${trigger}`).toBeNull();
      expect(r.trace?.candidates.find((c) => c.folder_id === paused.id)?.verdict).toBe("paused");
    }
  });

  // This is a LADDER CONTRACT, not a covered production path: no caller in
  // src/ passes trigger:"manual" to decideFolder today (manual moves go
  // straight through move-email.server.ts performMove, which is audit path
  // 9 and does NOT consult this rung — see folder-write-contracts.test.ts,
  // which fails the day a caller starts routing manual moves through here).
  // The behaviour is specified so that wiring it up is a one-line change
  // rather than a redesign.
  it("would refuse a paused destination for a manual move, if any caller routed one here", () => {
    const paused = folder({ ...invoices, processing_enabled: false });
    const r = decideFolder(parsed, context({ folders: [paused] }), {
      trigger: "manual",
      manualFolderId: paused.id,
    });
    expect(r.folder_id).toBeNull();
    expect(r.classified_by).toBe("none");
    expect(r.classification_reason).toContain("paused");
  });
});

describe("rung 2 — an exclude rule vetoes the folder", () => {
  it("vetoes even when the folder's Gmail label is present", () => {
    const ctx = context({
      folders: [invoices],
      filters: [invoiceFilter, filter("f-inv", "body", "not_contains", "attached")],
    });
    const r = decideFolder(parsed, ctx, { trigger: "label_change", labeledFolderId: "f-inv" });
    expect(r.folder_id).toBeNull();
    expect(r.trace?.candidates.find((c) => c.folder_id === "f-inv")?.verdict).toBe("vetoed");
  });
});

describe("rung 3 — the always-inbox override", () => {
  const overrides = [{ id: "o1", match_type: "domain", value: "stripe.com" }];

  it("wins over a filter match", () => {
    const r = decideFolder(
      parsed,
      context({ folders: [invoices], filters: [invoiceFilter], overrides }),
      { trigger: "arrival" },
    );
    expect(r.folder_id).toBeNull();
    expect(r.classified_by).toBe("inbox_override");
    expect(r.classification_reason).toContain("stripe.com");
  });

  it("a folder with overrides_inbox_override opts out of it", () => {
    const strong = folder({ ...invoices, overrides_inbox_override: true });
    const r = decideFolder(
      parsed,
      context({ folders: [strong], filters: [invoiceFilter], overrides }),
      { trigger: "arrival" },
    );
    expect(r.folder_id).toBe("f-inv");
    expect(r.classification_reason).toContain("beat inbox override");
  });

  it("an override exception lets the message be sorted normally", () => {
    const r = decideFolder(
      parsed,
      context({
        folders: [folder({ ...invoices, gmail_label_id: null })],
        filters: [invoiceFilter],
        overrides,
        overrideExceptions: [
          { override_id: "o1", field: "subject", op: "starts_with", value: "Your invoice" },
        ],
      }),
      { trigger: "arrival" },
    );
    expect(r.folder_id).toBe("f-inv");
    expect(r.classified_by).not.toBe("inbox_override");
    expect(r.classification_reason).toContain("exception to inbox override");
  });

  it("an exception that fires with nothing to match falls through to AI, and says so", () => {
    const aiFolder = folder({ id: "f-ai", name: "Work", ai_rule: "work mail" });
    const r = decideFolder(
      parsed,
      context({
        folders: [aiFolder],
        overrides,
        overrideExceptions: [
          { override_id: "o1", field: "subject", op: "contains", value: "invoice" },
        ],
      }),
      { trigger: "arrival" },
    );
    expect(r.folder_id).toBeNull();
    expect(r.needs_ai).toBe(true);
    expect(r.classification_reason).toContain("bypassed by exception");
  });
});

describe("rung 4 — a linked Gmail label routes before filters are consulted", () => {
  it("files into the folder whose label the message carries", () => {
    const labeled = { ...parsed, raw_labels: ["INBOX", "Label_9"] };
    const r = decideFolder(labeled, context({ folders: [invoices] }), { trigger: "arrival" });
    expect(r.folder_id).toBe("f-inv");
    expect(r.classified_by).toBe("gmail_label");
    expect(r.ai_confidence).toBe(1);
  });

  it("skipGmailLabelMatch suppresses the shortcut and re-derives from rules", () => {
    const labeled = { ...parsed, raw_labels: ["INBOX", "Label_9"] };
    const rules = folder({ id: "f-rule", name: "Rule", ai_rule: null });
    const r = decideFolder(
      labeled,
      context({
        folders: [invoices, rules],
        filters: [filter("f-rule", "from", "contains", "billing@stripe.com")],
      }),
      { trigger: "reanalyze", skipGmailLabelMatch: true },
    );
    expect(r.folder_id).toBe("f-rule");
    expect(r.classified_by).toBe("filter");
  });

  it("a label_change names the folder explicitly and stamps its own provenance", () => {
    const r = decideFolder(parsed, context({ folders: [invoices] }), {
      trigger: "label_change",
      labeledFolderId: "f-inv",
    });
    expect(r.folder_id).toBe("f-inv");
    expect(r.classified_by).toBe("gmail_labeled");
  });
});

describe("rung 5 — the filter engine picks the highest-priority survivor", () => {
  it("highest priority wins, and the trace says why", () => {
    const receipts = folder({
      id: "f-rec",
      name: "Receipts",
      priority: 5,
      gmail_label_id: null,
      ai_rule: null,
    });
    const ctx = context({
      folders: [folder({ ...invoices, gmail_label_id: null }), receipts],
      filters: [invoiceFilter, filter("f-rec", "subject", "contains", "invoice")],
    });
    const r = decideFolder(parsed, ctx, { trigger: "arrival" });
    expect(r.folder_id).toBe("f-rec");
    expect(r.classified_by).toBe("filter");
    expect(r.matched_folder_ids).toContain("f-inv");
    expect(r.trace?.tiebreak).toBe("2 folders matched — highest priority won");
  });

  it("a domain rule is stamped domain_rule, a non-domain rule filter", () => {
    const dom = decideFolder(
      parsed,
      context({
        folders: [folder({ ...invoices, gmail_label_id: null })],
        filters: [filter("f-inv", "domain", "contains", "stripe.com")],
      }),
      { trigger: "arrival" },
    );
    expect(dom.classified_by).toBe("domain_rule");

    const flt = decideFolder(
      parsed,
      context({
        folders: [folder({ ...invoices, gmail_label_id: null })],
        filters: [invoiceFilter],
      }),
      { trigger: "arrival" },
    );
    expect(flt.classified_by).toBe("filter");
    expect(flt.matched_filter_ids).toEqual([invoiceFilter.id]);
  });

  it("a filter_tree takes precedence over the folder's flat filters", () => {
    const tree = folder({
      id: "f-tree",
      name: "Tree",
      ai_rule: null,
      filter_tree: {
        type: "group",
        op: "and",
        children: [
          { type: "cond", field: "from", op: "contains", value: "@stripe.com" },
          { type: "cond", field: "subject", op: "contains", value: "invoice" },
        ],
      },
    });
    const ctx = context({
      folders: [tree],
      // A flat rule that would match nothing — the tree, not this, decides.
      filters: [filter("f-tree", "subject", "contains", "never-matches")],
    });
    expect(decideFolder(parsed, ctx, { trigger: "arrival" }).folder_id).toBe("f-tree");
    expect(
      decideFolder({ ...parsed, subject: "Newsletter" }, ctx, { trigger: "arrival" }).folder_id,
    ).toBeNull();
  });

  it("'all' filter logic requires every include rule to match", () => {
    const strict = folder({ id: "f-all", name: "Strict", filter_logic: "all", ai_rule: null });
    const ctx = context({
      folders: [strict],
      filters: [
        filter("f-all", "subject", "contains", "invoice"),
        filter("f-all", "from", "contains", "billing"),
      ],
    });
    expect(decideFolder(parsed, ctx, { trigger: "arrival" }).folder_id).toBe("f-all");
    expect(
      decideFolder({ ...parsed, from_addr: "alice@x.test" }, ctx, { trigger: "arrival" }).folder_id,
    ).toBeNull();
  });

  it("a vetoed folder reports 'excluded' and takes AI off the table", () => {
    const r = decideFolder(
      parsed,
      context({
        folders: [folder({ ...invoices, gmail_label_id: null, ai_rule: "invoices" })],
        filters: [invoiceFilter, filter("f-inv", "from", "not_contains", "stripe")],
      }),
      { trigger: "arrival" },
    );
    expect(r.folder_id).toBeNull();
    expect(r.classified_by).toBe("excluded");
    expect(r.needs_ai).toBe(false);
  });
});

describe("rung 6 — the calendar cold-email guard", () => {
  const cold = () =>
    folder({ id: "f-cold", name: "Cold Email", is_cold_email: true, ai_rule: null });
  const coldRule = filter("f-cold", "from", "contains", "met@partner.com");
  const met = { ...parsed, from_addr: "met@partner.com" };
  const guarded = (over: Parameters<typeof context>[0] = {}) =>
    context({
      folders: [cold()],
      filters: [coldRule],
      calendarGuardEnabled: true,
      calendarContacts: new Set(["met@partner.com"]),
      ...over,
    });

  it("keeps a known calendar contact OUT of a cold-email folder", () => {
    const r = decideFolder(met, guarded(), { trigger: "arrival" });
    expect(r.folder_id).toBeNull();
    expect(r.classified_by).toBe("calendar_contact");
    expect(r.classification_reason).toContain("Cold Email");
    expect(r.trace?.steps.find((s) => s.rung === "calendar_guard")).toMatchObject({
      outcome: "applied",
    });
  });

  it("matches the sender case-insensitively", () => {
    const r = decideFolder({ ...met, from_addr: "Met@Partner.com" }, guarded(), {
      trigger: "arrival",
    });
    expect(r.classified_by).toBe("calendar_contact");
  });

  it("still files a calendar contact into a folder that is NOT cold-email", () => {
    const factory = folder({ id: "f-fact", name: "Factory", ai_rule: null });
    const r = decideFolder(
      met,
      guarded({
        folders: [factory],
        filters: [filter("f-fact", "domain", "contains", "partner.com")],
      }),
      { trigger: "arrival" },
    );
    expect(r.folder_id).toBe("f-fact");
    expect(r.classified_by).toBe("domain_rule");
  });

  it("does nothing when the guard is switched off for the account", () => {
    const r = decideFolder(met, guarded({ calendarGuardEnabled: false }), { trigger: "arrival" });
    expect(r.folder_id).toBe("f-cold");
    expect(r.classified_by).not.toBe("calendar_contact");
  });

  it("does nothing for a sender who is not a calendar contact", () => {
    const stranger = { ...parsed, from_addr: "stranger@cold.test" };
    const r = decideFolder(
      stranger,
      guarded({ filters: [filter("f-cold", "from", "contains", "stranger@cold.test")] }),
      { trigger: "arrival" },
    );
    expect(r.folder_id).toBe("f-cold");
    expect(r.classified_by).not.toBe("calendar_contact");
  });
});

// needs_ai gates whether the AI pass runs AND whether process-message can
// finalize the row in one INSERT (no flicker), so it must be false for every
// TERMINAL rules outcome and true only when there is something left to ask.
describe("rung 7 — needs_ai eligibility", () => {
  const aiFolder = folder({ id: "f1", name: "Work", ai_rule: "route mail here" });
  const stranger = { ...parsed, from_addr: "nobody@nowhere.test", subject: "" };

  it("only folders that carry an ai_rule make the AI pending", () => {
    const noRule = decideFolder(
      stranger,
      context({ folders: [folder({ id: "f1", name: "Work", ai_rule: null })] }),
      { trigger: "arrival" },
    );
    expect(noRule.needs_ai).toBe(false);

    const withRule = decideFolder(stranger, context({ folders: [aiFolder] }), {
      trigger: "arrival",
    });
    expect(withRule.needs_ai).toBe(true);
  });

  it("a skip_ai folder is not an AI candidate", () => {
    const r = decideFolder(
      stranger,
      context({ folders: [folder({ ...aiFolder, skip_ai: true })] }),
      { trigger: "arrival" },
    );
    expect(r.needs_ai).toBe(false);
  });

  it("is false with no folders at all", () => {
    expect(decideFolder(stranger, context(), { trigger: "arrival" }).needs_ai).toBe(false);
  });

  it("is false once a rule filed the mail", () => {
    const r = decideFolder(
      parsed,
      context({
        folders: [folder({ ...aiFolder, gmail_label_id: null })],
        filters: [filter("f1", "from", "contains", "@stripe.com")],
      }),
      { trigger: "arrival" },
    );
    expect(r.folder_id).toBe("f1");
    expect(r.needs_ai).toBe(false);
  });

  it("is false once a Gmail label filed the mail", () => {
    const r = decideFolder(
      { ...parsed, raw_labels: ["INBOX", "Label_9"] },
      context({ folders: [folder({ ...aiFolder, gmail_label_id: "Label_9" })] }),
      { trigger: "arrival" },
    );
    expect(r.classified_by).toBe("gmail_label");
    expect(r.needs_ai).toBe(false);
  });

  it("is false for an inbox override — the AI must not overrule the pin", () => {
    const r = decideFolder(
      stranger,
      context({
        folders: [aiFolder],
        overrides: [{ id: "o1", match_type: "domain", value: "nowhere.test" }],
      }),
      { trigger: "arrival" },
    );
    expect(r.classified_by).toBe("inbox_override");
    expect(r.needs_ai).toBe(false);
  });
});

describe("rung 8 — the surface-to-inbox rule", () => {
  it("filing into a folder with a surface rule requests the surface check", () => {
    const surfaced = folder({
      ...invoices,
      gmail_label_id: null,
      surface_ai_rule: "keep mail addressed to me personally",
    });
    const r = decideFolder(parsed, context({ folders: [surfaced], filters: [invoiceFilter] }), {
      trigger: "arrival",
    });
    expect(r.folder_id).toBe("f-inv");
    expect(r.needs_surface_check).toBe(true);
  });

  it("a blank surface rule does not request the check", () => {
    const surfaced = folder({ ...invoices, gmail_label_id: null, surface_ai_rule: "   " });
    const r = decideFolder(parsed, context({ folders: [surfaced], filters: [invoiceFilter] }), {
      trigger: "arrival",
    });
    expect(r.needs_surface_check).toBe(false);
  });
});

describe("rung 9 — nothing matched", () => {
  it("leaves the message in the inbox with classified_by 'none'", () => {
    const r = decideFolder(parsed, context({ folders: [] }), { trigger: "arrival" });
    expect(r.folder_id).toBeNull();
    expect(r.classified_by).toBe("none");
    expect(r.needs_ai).toBe(false);
    expect(r.trace?.steps.at(-1)).toMatchObject({ rung: "none", outcome: "applied" });
  });
});

describe("the trace", () => {
  it("every decision carries a versioned trace naming its trigger", () => {
    for (const trigger of triggers) {
      const r = decideFolder(parsed, context({ folders: [invoices], filters: [invoiceFilter] }), {
        trigger,
      });
      expect(r.trace?.version, `trigger=${trigger}`).toBe(1);
      expect(r.trace?.trigger).toBe(trigger);
      expect(r.trace?.steps.length).toBeGreaterThan(0);
    }
  });
});
