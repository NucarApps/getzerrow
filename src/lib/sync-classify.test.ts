// classifyParsedEmail covers the routing decision tree:
//   gmail label match  >  inbox override (with exceptions)  >  folder filter
//   tree  >  simple any/all filters  >  AI fallback (skipAi=true here)
//
// These tests pass a synthetic AccountContext so loadAccountContext never
// touches Supabase, and use skipAi=true so we never hit the AI Gateway.
import { describe, it, expect } from "vitest";
import { classifyParsedEmail, type AccountContext } from "./sync.server";

type Folder = AccountContext["folders"][number];
type Filter = AccountContext["filters"][number];

function folder(over: Partial<Folder> = {}): Folder {
  return {
    id: over.id ?? "f-default",
    name: over.name ?? "Default",
    gmail_label_id: over.gmail_label_id ?? null,
    ai_rule: over.ai_rule ?? null,
    learned_profile: over.learned_profile ?? null,
    last_learned_at: over.last_learned_at ?? null,
    auto_archive: over.auto_archive ?? false,
    auto_mark_read: over.auto_mark_read ?? false,
    auto_star: over.auto_star ?? false,
    hide_from_inbox: over.hide_from_inbox ?? false,
    skip_ai: over.skip_ai ?? false,
    priority: over.priority ?? 0,
    gmail_account_id: over.gmail_account_id ?? "acc-1",
    filter_logic: over.filter_logic ?? "any",
    filter_tree: over.filter_tree ?? null,
    forward_to: over.forward_to ?? null,
    min_ai_confidence: over.min_ai_confidence ?? 0,
    snooze_hours: over.snooze_hours ?? 0,
    overrides_inbox_override: over.overrides_inbox_override ?? false,
    is_cold_email: over.is_cold_email ?? false,
  };
}

function filter(folder_id: string, field: string, op: string, value: string, id = ""): Filter {
  return { id: id || `${folder_id}-${field}-${value}`, folder_id, field, op, value };
}

function ctx(over: Partial<AccountContext> = {}): AccountContext {
  return {
    folders: over.folders ?? [],
    filters: over.filters ?? [],
    overrides: over.overrides ?? [],
    overrideExceptions: over.overrideExceptions ?? [],
    enrichedFolders: over.enrichedFolders ?? [],
    calendarGuardEnabled: over.calendarGuardEnabled ?? false,
    calendarContacts: over.calendarContacts ?? new Set<string>(),
  };
}

function email(
  over: Partial<Parameters<typeof classifyParsedEmail>[0]> = {},
): Parameters<typeof classifyParsedEmail>[0] {
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

const opts = { context: undefined as AccountContext | undefined, skipAi: true };

describe("classifyParsedEmail — gmail label match", () => {
  it("classifies by Gmail label when the message already carries the folder's linked label", async () => {
    const f = folder({ id: "f1", name: "Newsletters", gmail_label_id: "Label_42" });
    const c = ctx({ folders: [f] });
    const r = await classifyParsedEmail(
      email({ raw_labels: ["INBOX", "Label_42"] }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(r.folder_id).toBe("f1");
    expect(r.classified_by).toBe("gmail_label");
    expect(r.ai_confidence).toBe(1);
  });

  it("skipGmailLabelMatch suppresses the label shortcut and falls through to filters", async () => {
    const f1 = folder({ id: "f-label", gmail_label_id: "Label_42", name: "Labeled" });
    const f2 = folder({ id: "f-rule", name: "Rule" });
    const filters: Filter[] = [filter("f-rule", "from", "contains", "sender")];
    const c = ctx({ folders: [f1, f2], filters });
    const r = await classifyParsedEmail(
      email({ raw_labels: ["INBOX", "Label_42"] }),
      "user-1",
      "acc-1",
      { ...opts, context: c, skipGmailLabelMatch: true },
    );
    // With label match suppressed and the filter on f-rule matching the from, we land in f-rule.
    expect(r.folder_id).toBe("f-rule");
    expect(r.classified_by).toBe("filter");
  });
});

describe("classifyParsedEmail — inbox overrides (allowlist)", () => {
  it("forces email to inbox (no folder) when an `email` override matches the from address", async () => {
    const c = ctx({
      overrides: [{ id: "o1", match_type: "email", value: "vip@good.com" }],
    });
    const r = await classifyParsedEmail(email({ from_addr: "vip@good.com" }), "user-1", "acc-1", {
      ...opts,
      context: c,
    });
    expect(r.folder_id).toBeNull();
    expect(r.classified_by).toBe("inbox_override");
    expect(r.classification_reason).toContain("vip@good.com");
  });

  it("forces email to inbox when a `domain` override matches the from domain", async () => {
    const c = ctx({
      overrides: [{ id: "o1", match_type: "domain", value: "vip.example" }],
    });
    const r = await classifyParsedEmail(
      email({ from_addr: "ceo@vip.example" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(r.folder_id).toBeNull();
    expect(r.classified_by).toBe("inbox_override");
  });

  it("override ignores a matching folder filter (allowlist beats sorting)", async () => {
    const f = folder({ id: "f1", name: "Newsletters" });
    const filters: Filter[] = [filter("f1", "from", "contains", "newsletter")];
    const c = ctx({
      folders: [f],
      filters,
      overrides: [{ id: "o1", match_type: "email", value: "newsletter@vip.example" }],
    });
    const r = await classifyParsedEmail(
      email({ from_addr: "newsletter@vip.example" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(r.folder_id).toBeNull();
    expect(r.classified_by).toBe("inbox_override");
  });

  it("an override exception lets the email be sorted normally", async () => {
    const f = folder({ id: "f1", name: "Reports" });
    const filters: Filter[] = [filter("f1", "subject", "contains", "Daily Report")];
    const c = ctx({
      folders: [f],
      filters,
      overrides: [{ id: "o1", match_type: "domain", value: "vip.example" }],
      overrideExceptions: [
        { override_id: "o1", field: "subject", op: "starts_with", value: "Daily Report" },
      ],
    });
    const r = await classifyParsedEmail(
      email({ from_addr: "bot@vip.example", subject: "Daily Report — 5/24" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(r.classified_by).not.toBe("inbox_override");
    expect(r.folder_id).toBe("f1");
  });

  it("`overrides_inbox_override` folder beats a matching override", async () => {
    const beating = folder({ id: "f-beat", name: "Beats", overrides_inbox_override: true });
    const filters: Filter[] = [filter("f-beat", "from", "contains", "ceo@")];
    const c = ctx({
      folders: [beating],
      filters,
      overrides: [{ id: "o1", match_type: "domain", value: "blocked.com" }],
    });
    const r = await classifyParsedEmail(
      email({ from_addr: "ceo@blocked.com" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(r.folder_id).toBe("f-beat");
    expect(r.classification_reason).toContain("beat inbox override");
  });
});

describe("classifyParsedEmail — filters", () => {
  it("classifies via a simple 'any' include filter", async () => {
    const f = folder({ id: "f1", name: "Updates", filter_logic: "any" });
    const filters: Filter[] = [filter("f1", "subject", "contains", "updates")];
    const c = ctx({ folders: [f], filters });
    const r = await classifyParsedEmail(
      email({ subject: "Weekly updates from Acme" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(r.folder_id).toBe("f1");
    expect(r.classified_by).toBe("filter");
    expect(r.matched_filter_ids.length).toBe(1);
  });

  it("classifies via 'domain_rule' specifically for from-domain matches", async () => {
    const f = folder({ id: "f1", name: "Updates" });
    const filters: Filter[] = [filter("f1", "domain", "contains", "acme.com")];
    const c = ctx({ folders: [f], filters });
    const r = await classifyParsedEmail(
      email({ from_addr: "support@acme.com" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(r.classified_by).toBe("domain_rule");
  });

  it("'all' filter logic requires every include to match", async () => {
    const f = folder({ id: "f-all", name: "Strict", filter_logic: "all" });
    const filters: Filter[] = [
      filter("f-all", "subject", "contains", "invoice"),
      filter("f-all", "from", "contains", "billing"),
    ];
    const c = ctx({ folders: [f], filters });
    // Only matches one of the two — should NOT classify.
    const r1 = await classifyParsedEmail(
      email({ subject: "Invoice attached", from_addr: "alice@x.com" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(r1.folder_id).toBeNull();
    // Matches both → classifies.
    const r2 = await classifyParsedEmail(
      email({ subject: "Invoice attached", from_addr: "billing@acme.com" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(r2.folder_id).toBe("f-all");
  });

  it("an exclude filter (not_contains) blocks an otherwise-matching folder", async () => {
    const f = folder({ id: "f1", name: "Marketing" });
    const filters: Filter[] = [
      filter("f1", "subject", "contains", "promo"),
      filter("f1", "from", "not_contains", "internal"),
    ];
    const c = ctx({ folders: [f], filters });
    const r = await classifyParsedEmail(
      email({ subject: "Promo code inside", from_addr: "internal-comms@x.com" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    // Subject matches, but exclude on `from` fires → excluded.
    expect(r.classified_by).toBe("excluded");
    expect(r.folder_id).toBeNull();
  });

  it("higher-priority folder wins when multiple folders match", async () => {
    const low = folder({ id: "low", name: "Low", priority: 0 });
    const high = folder({ id: "high", name: "High", priority: 10 });
    const filters: Filter[] = [
      filter("low", "subject", "contains", "shared"),
      filter("high", "subject", "contains", "shared"),
    ];
    const c = ctx({ folders: [high, low], filters });
    const r = await classifyParsedEmail(email({ subject: "shared keyword" }), "user-1", "acc-1", {
      ...opts,
      context: c,
    });
    expect(r.folder_id).toBe("high");
  });

  it("filter_tree (group with and/or operands) takes precedence over flat filters", async () => {
    const f = folder({
      id: "f-tree",
      name: "Tree",
      filter_tree: {
        type: "group",
        op: "and",
        children: [
          { type: "cond", field: "from", op: "contains", value: "@acme.com" },
          { type: "cond", field: "subject", op: "contains", value: "invoice" },
        ],
      },
    });
    const c = ctx({ folders: [f] });
    const match = await classifyParsedEmail(
      email({ from_addr: "billing@acme.com", subject: "Invoice 42" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(match.folder_id).toBe("f-tree");
    expect(match.classified_by).toBe("filter");

    const noMatch = await classifyParsedEmail(
      email({ from_addr: "billing@acme.com", subject: "Newsletter" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(noMatch.folder_id).toBeNull();
  });
});

describe("classifyParsedEmail — calendar cold-email guard", () => {
  it("keeps a known calendar contact OUT of a cold-email folder", async () => {
    const cold = folder({ id: "f-cold", name: "Cold Email", is_cold_email: true });
    const filters: Filter[] = [filter("f-cold", "from", "contains", "met@partner.com")];
    const c = ctx({
      folders: [cold],
      filters,
      calendarGuardEnabled: true,
      calendarContacts: new Set(["met@partner.com"]),
    });
    const r = await classifyParsedEmail(
      email({ from_addr: "met@partner.com" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(r.folder_id).toBeNull();
    expect(r.classified_by).toBe("calendar_contact");
    expect(r.classification_reason).toContain("Cold Email");
  });

  it("still files a known calendar contact into a NON-cold folder (e.g. domain rule)", async () => {
    const factory = folder({ id: "f-factory", name: "Factory" });
    const filters: Filter[] = [filter("f-factory", "domain", "contains", "partner.com")];
    const c = ctx({
      folders: [factory],
      filters,
      calendarGuardEnabled: true,
      calendarContacts: new Set(["met@partner.com"]),
    });
    const r = await classifyParsedEmail(
      email({ from_addr: "met@partner.com" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(r.folder_id).toBe("f-factory");
    expect(r.classified_by).toBe("domain_rule");
  });

  it("matches cold-email folder case-insensitively on the sender", async () => {
    const cold = folder({ id: "f-cold", name: "Cold Email", is_cold_email: true });
    const filters: Filter[] = [filter("f-cold", "from", "contains", "met@partner.com")];
    const c = ctx({
      folders: [cold],
      filters,
      calendarGuardEnabled: true,
      calendarContacts: new Set(["met@partner.com"]),
    });
    const r = await classifyParsedEmail(
      email({ from_addr: "Met@Partner.com" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(r.classified_by).toBe("calendar_contact");
  });

  it("does not fire when the guard is disabled even if the contact would hit cold email", async () => {
    const cold = folder({ id: "f-cold", name: "Cold Email", is_cold_email: true });
    const filters: Filter[] = [filter("f-cold", "from", "contains", "met@partner.com")];
    const c = ctx({
      folders: [cold],
      filters,
      calendarGuardEnabled: false,
      calendarContacts: new Set(["met@partner.com"]),
    });
    const r = await classifyParsedEmail(
      email({ from_addr: "met@partner.com" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(r.classified_by).not.toBe("calendar_contact");
    expect(r.folder_id).toBe("f-cold");
  });

  it("does not fire for senders not in the calendar contact set", async () => {
    const cold = folder({ id: "f-cold", name: "Cold Email", is_cold_email: true });
    const filters: Filter[] = [filter("f-cold", "from", "contains", "stranger@cold.com")];
    const c = ctx({
      folders: [cold],
      filters,
      calendarGuardEnabled: true,
      calendarContacts: new Set(["met@partner.com"]),
    });
    const r = await classifyParsedEmail(
      email({ from_addr: "stranger@cold.com" }),
      "user-1",
      "acc-1",
      { ...opts, context: c },
    );
    expect(r.classified_by).not.toBe("calendar_contact");
    expect(r.folder_id).toBe("f-cold");
  });
});


describe("classifyParsedEmail — skipAi behavior", () => {
  it("returns null folder with classified_by='none' when no match and skipAi=true", async () => {
    const r = await classifyParsedEmail(
      email({ from_addr: "nobody@nowhere.test" }),
      "user-1",
      "acc-1",
      { context: ctx(), skipAi: true },
    );
    expect(r.folder_id).toBeNull();
    expect(r.classified_by).toBe("none");
  });
});
