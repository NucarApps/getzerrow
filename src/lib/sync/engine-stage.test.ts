// The Phase E cutover switch, mode by mode. These tests pin the contract
// that matters during a live migration: shadow mode changes nothing, "on"
// hands the decision to the amended engine, and an engine failure can
// never stop mail from being filed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runEngineStage } from "./engine-stage";
import type { AccountContext } from "./account-context";
import type { ParsedEmailForClassify } from "./classify";
import type { FolderDecision } from "./decide-folder";
import type { Filter, Folder } from "./types";

vi.mock("../log.server", () => ({
  logInfo: vi.fn(),
  logMetric: vi.fn(),
  logError: vi.fn(),
}));

function folder(over: Partial<Folder> = {}): Folder {
  return {
    id: "receipts",
    name: "Receipts",
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

const filterRow = (folder_id: string, field: string, op: string, value: string): Filter =>
  ({ id: `${folder_id}-${value}`, folder_id, field, op, value }) as unknown as Filter;

const context = (over: Partial<AccountContext> = {}): AccountContext =>
  ({
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
  }) as unknown as AccountContext;

const parsed = (): ParsedEmailForClassify =>
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
  }) as ParsedEmailForClassify;

const legacyDecision = (over: Partial<FolderDecision> = {}): FolderDecision =>
  ({
    folder_id: null,
    classified_by: "none",
    ai_confidence: 0,
    ai_summary: "",
    classification_reason: null,
    matched_filter_ids: [],
    matched_folder_ids: [],
    needs_ai: false,
    needs_surface_check: false,
    ...over,
  }) as FolderDecision;

const matchingContext = () => {
  const folders = [folder()];
  const filters = [filterRow("receipts", "from", "contains", "billing@netflix.com")];
  return context({ folders, filters });
};

afterEach(() => {
  vi.stubEnv("RULES_ENGINE_V2", undefined);
});

describe("runEngineStage", () => {
  it("returns the legacy decision untouched when the engine is off", () => {
    vi.stubEnv("RULES_ENGINE_V2", "off");
    const legacy = legacyDecision();
    const out = runEngineStage(parsed(), matchingContext(), legacy);
    expect(out).toBe(legacy);
  });

  it("shadows by default: legacy still decides even when the engine differs", () => {
    const legacy = legacyDecision();
    const out = runEngineStage(parsed(), matchingContext(), legacy);
    expect(out).toBe(legacy);
    expect(out.folder_id).toBeNull();
    expect(out.rules_trace).toBeUndefined();
  });

  it("logs a disagreement in shadow mode with ids and stages only", async () => {
    const { logInfo } = await import("../log.server");
    runEngineStage(parsed(), matchingContext(), legacyDecision());
    expect(logInfo).toHaveBeenCalledWith(
      "rules_engine.disagreement",
      expect.objectContaining({
        mode: "shadow",
        engine_folder_id: "receipts",
        engine_stage: "rule",
      }),
    );
    const logged = JSON.stringify(vi.mocked(logInfo).mock.calls);
    expect(logged).not.toContain("Your receipt");
  });

  it("hands the decision to the engine when on, and attaches the v2 trace", () => {
    vi.stubEnv("RULES_ENGINE_V2", "on");
    const out = runEngineStage(parsed(), matchingContext(), legacyDecision());
    expect(out.folder_id).toBe("receipts");
    expect(out.classified_by).toBe("filter");
    expect(out.classification_reason).toContain("L1 exact sender");
    expect(out.matched_folder_ids).toEqual(["receipts"]);
    expect(out.matched_filter_ids).toEqual(["receipts-billing@netflix.com"]);
    expect(out.rules_trace?.version).toBe(2);
  });

  it("keeps synthetic tree rule ids out of matched_filter_ids", () => {
    vi.stubEnv("RULES_ENGINE_V2", "on");
    const folders = [
      folder({
        filter_tree: {
          type: "group",
          op: "or",
          children: [{ type: "cond", field: "from", op: "contains", value: "billing@netflix.com" }],
        },
      }),
    ];
    const out = runEngineStage(parsed(), context({ folders }), legacyDecision());
    expect(out.folder_id).toBe("receipts");
    expect(out.matched_filter_ids).toEqual([]);
  });

  it("preserves the legacy classifier while the engine defers to AI", () => {
    vi.stubEnv("RULES_ENGINE_V2", "on");
    const folders = [folder({ id: "misc", name: "Misc", ai_rule: "anything odd" })];
    const out = runEngineStage(
      parsed(),
      context({ folders }),
      legacyDecision({ classified_by: "none", needs_ai: true }),
    );
    expect(out.needs_ai).toBe(true);
    expect(out.folder_id).toBeNull();
    expect(out.classified_by).toBe("none");
  });

  it("drops a surface check that belongs to a folder the engine did not pick", () => {
    vi.stubEnv("RULES_ENGINE_V2", "on");
    const out = runEngineStage(
      parsed(),
      matchingContext(),
      legacyDecision({ folder_id: "other", needs_surface_check: true }),
    );
    expect(out.folder_id).toBe("receipts");
    expect(out.needs_surface_check).toBe(false);
  });

  it("falls back to the legacy decision when the engine throws", () => {
    vi.stubEnv("RULES_ENGINE_V2", "on");
    const legacy = legacyDecision({ folder_id: "legacy-folder" });
    const broken = context({
      // A Map-shaped field replaced by something that throws on read is
      // the cheapest way to make the bridge fail mid-flight.
      senderGroups: {
        get() {
          throw new Error("boom");
        },
      } as unknown as Map<string, Set<string>>,
    });
    const out = runEngineStage(parsed(), broken, legacy);
    expect(out).toBe(legacy);
  });
});
