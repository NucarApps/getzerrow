import { describe, expect, it } from "vitest";
import { pinsForMessage, runRulesEngine, toEngineMessage } from "./bridge";
import { toRules } from "./adapt";
import type { AccountContext } from "../sync/account-context";
import type { Filter, Folder } from "../sync/types";
import type { ParsedEmailForClassify } from "../sync/classify";

function folder(over: Partial<Folder> = {}): Folder {
  return {
    id: "f1",
    name: "Default",
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
    processing_enabled: true,
    ...over,
  } as Folder;
}

const filter = (folder_id: string, field: string, op: string, value: string): Filter =>
  ({ id: `${folder_id}-${field}-${value}`, folder_id, field, op, value }) as unknown as Filter;

function context(over: Partial<AccountContext> = {}): AccountContext {
  return {
    folders: [],
    filters: [],
    overrides: [],
    overrideExceptions: [],
    enrichedFolders: [],
    calendarGuardEnabled: false,
    calendarContacts: new Set<string>(),
    accountEmail: "me@example.com",
    senderGroups: new Map<string, Set<string>>(),
    markReadRules: [],
    ...over,
  } as unknown as AccountContext;
}

const parsed = (over: Partial<ParsedEmailForClassify> = {}): ParsedEmailForClassify =>
  ({
    from_addr: "billing@netflix.com",
    from_name: "Netflix",
    to_addrs: "me@example.com",
    subject: "Your receipt",
    snippet: "",
    body_text: "",
    body_html: "",
    has_attachment: false,
    received_at: "2026-08-01T00:00:00.000Z",
    raw_labels: [],
    ...over,
  }) as ParsedEmailForClassify;

describe("toEngineMessage", () => {
  it("resolves the sender's contact groups so sender_in_group can evaluate", () => {
    const ctx = context({
      senderGroups: new Map([["billing@netflix.com", new Set(["g1", "g2"])]]),
    });
    expect(toEngineMessage(parsed(), ctx).sender_group_ids).toEqual(["g1", "g2"]);
  });

  it("keeps ids already attached by the caller", () => {
    const m = toEngineMessage(parsed({ sender_group_ids: ["given"] }), context());
    expect(m.sender_group_ids).toEqual(["given"]);
  });
});

describe("pinsForMessage", () => {
  const overrides = [{ id: "o1", match_type: "email", value: "billing@netflix.com" }];

  it("keeps an always-inbox override that nothing cancels", () => {
    const ctx = context({ overrides });
    const m = toEngineMessage(parsed(), ctx);
    expect(pinsForMessage(m, ctx, []).map((p) => p.id)).toEqual(["o1"]);
  });

  it("drops the pin when an override exception matches", () => {
    const ctx = context({
      overrides,
      overrideExceptions: [
        { override_id: "o1", field: "subject", op: "contains", value: "receipt" },
      ],
    });
    const m = toEngineMessage(parsed(), ctx);
    expect(pinsForMessage(m, ctx, [])).toEqual([]);
  });

  it("drops the pin when a folder allowed to beat the inbox list matches", () => {
    const folders = [folder({ id: "f1", overrides_inbox_override: true })];
    const filters = [filter("f1", "from", "contains", "billing@netflix.com")];
    const ctx = context({ overrides, folders, filters });
    const m = toEngineMessage(parsed(), ctx);
    expect(pinsForMessage(m, ctx, toRules(folders, filters))).toEqual([]);
  });
});

describe("runRulesEngine", () => {
  it("files by the adapted folder_filters rules", () => {
    const folders = [folder({ id: "receipts", name: "Receipts" })];
    const filters = [filter("receipts", "from", "contains", "billing@netflix.com")];
    const result = runRulesEngine(parsed(), context({ folders, filters }), {
      trigger: "arrival",
      aiEnabled: false,
    });
    expect(result.folder_id).toBe("receipts");
    expect(result.stage).toBe("rule");
  });

  it("honours an always-inbox pin over a matching rule", () => {
    const folders = [folder({ id: "receipts", name: "Receipts" })];
    const filters = [filter("receipts", "from", "contains", "billing@netflix.com")];
    const result = runRulesEngine(
      parsed(),
      context({
        folders,
        filters,
        overrides: [{ id: "o1", match_type: "domain", value: "netflix.com" }],
      }),
      { trigger: "arrival", aiEnabled: false },
    );
    expect(result.folder_id).toBeNull();
    expect(result.stage).toBe("pin");
  });

  it("never files into a paused folder", () => {
    const folders = [folder({ id: "receipts", processing_enabled: false })];
    const filters = [filter("receipts", "from", "contains", "billing@netflix.com")];
    const result = runRulesEngine(parsed(), context({ folders, filters }), {
      trigger: "arrival",
      aiEnabled: false,
    });
    expect(result.folder_id).toBeNull();
  });

  it("defers to AI only when a folder is described and the stage is enabled", () => {
    const folders = [folder({ id: "misc", name: "Misc", ai_rule: "anything odd" })];
    const ctx = context({ folders });
    const off = runRulesEngine(parsed(), ctx, { trigger: "arrival", aiEnabled: false });
    expect(off.needs_ai).toBe(false);
    const on = runRulesEngine(parsed(), ctx, { trigger: "arrival", aiEnabled: true });
    expect(on.needs_ai).toBe(true);
    expect(on.ai_candidate_folder_ids).toEqual(["misc"]);
  });
});
