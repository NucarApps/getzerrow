// Explain + feedback flow (rules upgrade, task 12). Contracts:
//
//   * getOwnedExecution rejects rows the caller doesn't own,
//   * alternative folders are deterministic: other folders whose rules
//     also matched, in priority order, current folder excluded, top 3.
//     (Pure matchByFilters — no AI, no scorer.)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));
vi.mock("../move-email.server", () => ({ performMove: vi.fn(async () => ({ ok: true })) }));
vi.mock("./encrypted-writer", () => ({
  insertFolderExampleEncrypted: vi.fn(async () => ({ id: "x", error: null })),
}));
vi.mock("./encrypted-reader", () => ({
  getEmailsDecrypted: vi.fn(async () => ({ rows: [], error: null })),
}));
vi.mock("./account-context", () => ({ loadAccountContext: vi.fn() }));
vi.mock("../log.server", () => ({ logAudit: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

const { getOwnedExecution } = await import("./classification-feedback.functions");
import { matchByFilters } from "./filter-engine";
import type { Folder, Filter } from "./types";

beforeEach(() => fake.reset());

describe("getOwnedExecution", () => {
  it("returns the row for its owner and rejects everyone else", async () => {
    fake.seed("executed_rules", [
      {
        id: "er-1",
        user_id: "u-1",
        gmail_account_id: "acc-1",
        email_id: "e-1",
        gmail_message_id: "gm-1",
        folder_id: "f-1",
        classified_by: "ai",
        ai_confidence: 0.9,
        matched_leaf_json: null,
      },
    ]);
    const row = await getOwnedExecution("er-1", "u-1");
    expect(row.email_id).toBe("e-1");
    await expect(getOwnedExecution("er-1", "attacker")).rejects.toThrow("Execution not found");
    await expect(getOwnedExecution("00000000-0000-0000-0000-000000000000", "u-1")).rejects.toThrow(
      "Execution not found",
    );
  });
});

describe("alternative folders (deterministic)", () => {
  function mkFolder(id: string, name: string, priority: number): Folder {
    return {
      id,
      name,
      gmail_label_id: null,
      ai_rule: null,
      learned_profile: null,
      last_learned_at: null,
      auto_archive: false,
      auto_mark_read: false,
      auto_star: false,
      hide_from_inbox: false,
      skip_ai: false,
      priority,
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
    };
  }
  it("all_matched_folder_ids ranks by priority — the explain payload's source of truth", () => {
    const folders = [mkFolder("f-low", "Low", 1), mkFolder("f-high", "High", 9)];
    const filters: Filter[] = [
      { id: "1", folder_id: "f-low", field: "subject", op: "contains", value: "invoice" },
      { id: "2", folder_id: "f-high", field: "subject", op: "contains", value: "invoice" },
    ];
    const m = matchByFilters(
      {
        from_addr: "a@x.com",
        from_name: "A",
        to_addrs: "me@x.com",
        subject: "invoice #1",
        body_text: "",
        has_attachment: false,
      },
      folders,
      filters,
    );
    expect(m?.kind).toBe("match");
    if (m?.kind === "match") {
      expect(m.all_matched_folder_ids).toEqual(["f-high", "f-low"]);
    }
  });
});
