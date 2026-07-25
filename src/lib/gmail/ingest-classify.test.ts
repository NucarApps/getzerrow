// The two Gmail ingest paths (searchGmailAndIngest, scanGmailForFolder) had
// ZERO test coverage before this, despite deciding where ingested mail lands.
// These pin the precedence so the two can share one implementation safely.
import { describe, it, expect } from "vitest";
import {
  classifyIngestedMessage,
  INGEST_SEED_CLASSIFIED_BY,
  type IngestCandidate,
  type IngestClassifyContext,
} from "./ingest-classify";
import type { Filter, Folder, RuleNode } from "../sync/types";

function folder(over: Partial<Folder> = {}): Folder {
  return {
    id: over.id ?? "f1",
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
    surface_ai_rule: over.surface_ai_rule ?? null,
    surface_names: over.surface_names ?? null,
  };
}

const filter = (
  folder_id: string,
  field: string,
  op: string,
  value: string,
  id?: string,
): Filter => ({ id: id ?? `${folder_id}-${field}-${value}`, folder_id, field, op, value });

function candidate(over: Partial<IngestCandidate> = {}): IngestCandidate {
  return {
    from_addr: "jane@acme.com",
    from_name: "Jane",
    to_addrs: "me@example.com",
    subject: "Quarterly report",
    body_text: "body",
    has_attachment: false,
    raw_labels: ["INBOX"],
    ...over,
  };
}

function ctx(over: Partial<IngestClassifyContext> = {}): IngestClassifyContext {
  return {
    labelToFolder: new Map(),
    folders: [],
    filters: [],
    seedReason: "Pulled from Gmail via search",
    ...over,
  };
}

describe("classifyIngestedMessage — no match", () => {
  it("leaves the message unfiled with the seed reason", () => {
    const r = classifyIngestedMessage(candidate(), ctx());
    expect(r).toEqual({
      folder_id: null,
      classified_by: INGEST_SEED_CLASSIFIED_BY,
      classification_reason: "Pulled from Gmail via search",
      matched_filter_ids: [],
    });
  });

  it("carries whichever seed reason the caller supplies", () => {
    const r = classifyIngestedMessage(
      candidate(),
      ctx({ seedReason: "Scanned for folder: Clients" }),
    );
    expect(r.classification_reason).toBe("Scanned for folder: Clients");
  });
});

describe("classifyIngestedMessage — a linked Gmail label wins", () => {
  const linked = ctx({
    labelToFolder: new Map([["Label_42", "folder-clients"]]),
    folders: [folder({ id: "folder-rules", name: "Rules" })],
    filters: [filter("folder-rules", "domain", "equals", "acme.com")],
  });

  it("files by label and says so", () => {
    const r = classifyIngestedMessage(candidate({ raw_labels: ["INBOX", "Label_42"] }), linked);
    expect(r).toEqual({
      folder_id: "folder-clients",
      classified_by: "gmail_label",
      classification_reason: "Matched Gmail label",
      matched_filter_ids: [],
    });
  });

  it("beats a filter that would also have matched", () => {
    // The user already filed this in Gmail; rules must not override that.
    const r = classifyIngestedMessage(candidate({ raw_labels: ["Label_42"] }), linked);
    expect(r.folder_id).toBe("folder-clients");
    expect(r.classified_by).toBe("gmail_label");
  });

  it("takes the first linked label when several are linked", () => {
    const many = ctx({
      labelToFolder: new Map([
        ["Label_A", "folder-a"],
        ["Label_B", "folder-b"],
      ]),
    });
    const r = classifyIngestedMessage(candidate({ raw_labels: ["Label_A", "Label_B"] }), many);
    expect(r.folder_id).toBe("folder-a");
  });

  it("ignores labels with no linked folder", () => {
    const r = classifyIngestedMessage(
      candidate({ raw_labels: ["Label_unlinked"] }),
      ctx({ labelToFolder: new Map([["Label_42", "folder-clients"]]) }),
    );
    expect(r.folder_id).toBeNull();
  });

  it("tolerates a message with no labels at all", () => {
    // `linked` also has a matching domain filter, so falling through to it is
    // correct — what matters is that no LABEL match was claimed.
    const r = classifyIngestedMessage(candidate({ raw_labels: null }), linked);
    expect(r.classified_by).not.toBe("gmail_label");
    expect(r.classified_by).toBe("domain_rule");
  });
});

describe("classifyIngestedMessage — filter match", () => {
  it("reports a domain rule as domain_rule with the value", () => {
    const r = classifyIngestedMessage(
      candidate(),
      ctx({
        folders: [folder({ id: "f-clients", name: "Clients" })],
        filters: [filter("f-clients", "domain", "equals", "acme.com")],
      }),
    );
    expect(r.folder_id).toBe("f-clients");
    expect(r.classified_by).toBe("domain_rule");
    expect(r.classification_reason).toBe("Domain rule: acme.com");
  });

  it("reports a non-domain rule as filter, naming field and value", () => {
    const r = classifyIngestedMessage(
      candidate({ subject: "Quarterly report" }),
      ctx({
        folders: [folder({ id: "f-reports", name: "Reports" })],
        filters: [filter("f-reports", "subject", "contains", "quarterly")],
      }),
    );
    expect(r.classified_by).toBe("filter");
    expect(r.classification_reason).toBe("Folder rule: subject quarterly");
  });

  it("returns the matched filter ids", () => {
    const r = classifyIngestedMessage(
      candidate(),
      ctx({
        folders: [folder({ id: "f-clients" })],
        filters: [filter("f-clients", "domain", "equals", "acme.com", "flt-1")],
      }),
    );
    expect(r.matched_filter_ids).toEqual(["flt-1"]);
  });

  it("derives the domain through the shared engine, so a malformed sender still matches", () => {
    // Regression guard: from_addr can hold a whole unnormalized From header.
    const r = classifyIngestedMessage(
      candidate({ from_addr: 'Jane "JD" Doe <jane@acme.com>' }),
      ctx({
        folders: [folder({ id: "f-clients" })],
        filters: [filter("f-clients", "domain", "equals", "acme.com")],
      }),
    );
    expect(r.folder_id).toBe("f-clients");
  });
});

describe("classifyIngestedMessage — rule-group (tree) match", () => {
  const tree: RuleNode = {
    type: "group",
    op: "or",
    children: [{ type: "cond", field: "domain", op: "equals", value: "acme.com" }],
  };

  it("says just 'Rule group matched' when the caller doesn't want the name", () => {
    const r = classifyIngestedMessage(
      candidate(),
      ctx({ folders: [folder({ id: "f-clients", name: "Clients", filter_tree: tree })] }),
    );
    expect(r.classified_by).toBe("filter");
    expect(r.classification_reason).toBe("Rule group matched");
  });

  it("names the folder when the caller asks (the scan path does)", () => {
    const r = classifyIngestedMessage(
      candidate(),
      ctx({
        folders: [folder({ id: "f-clients", name: "Clients", filter_tree: tree })],
        nameTreeMatches: true,
      }),
    );
    expect(r.classification_reason).toBe('Rule group matched for "Clients"');
  });

  it("renders an empty name as empty rather than throwing", () => {
    // The matched folder always comes from ctx.folders, so the lookup can't
    // miss; a blank name is the only degenerate case that reaches the string.
    const r = classifyIngestedMessage(
      candidate(),
      ctx({
        folders: [folder({ id: "f-clients", name: "", filter_tree: tree })],
        nameTreeMatches: true,
      }),
    );
    expect(r.classification_reason).toBe('Rule group matched for ""');
  });
});

describe("classifyIngestedMessage — partial-email limitation", () => {
  // Documented, pre-existing: ingest has no cc / list_id / is_reply /
  // sender_group_ids, so filters on those fields cannot match here. Pinned so
  // nobody "fixes" it accidentally without deciding to.
  it("does not match a cc filter", () => {
    const r = classifyIngestedMessage(
      candidate(),
      ctx({
        folders: [folder({ id: "f-cc" })],
        filters: [filter("f-cc", "cc", "contains", "me@example.com")],
      }),
    );
    expect(r.folder_id).toBeNull();
  });

  it("does not match a list_id filter", () => {
    const r = classifyIngestedMessage(
      candidate(),
      ctx({
        folders: [folder({ id: "f-list" })],
        filters: [filter("f-list", "list_id", "contains", "list.acme.com")],
      }),
    );
    expect(r.folder_id).toBeNull();
  });
});
