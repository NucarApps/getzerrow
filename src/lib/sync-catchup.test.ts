// buildCatchupRow turns one fetched+parsed Gmail message into the
// INSERT shape used by the bulk-catchup path. Critical contract:
// - Rules-matched mail carries final folder_id + flags (auto_archive
//   etc. baked into is_archived) so the single INSERT lands the row
//   in its destination list with no flicker.
// - AI-needed mail carries classified_by='pending_ai' and folder_id
//   null so it lands in the Inbox while the AI lane finishes.
// - Excluded-label messages (SENT/DRAFT/TRASH/SPAM/CHAT) are dropped.
// - Inbox-override (allowlist) stays terminal — AI must NOT route a
//   pinned sender into a folder.
import { describe, it, expect } from "vitest";
import { buildCatchupRow } from "./sync/catchup";
import type { AccountContext } from "./sync.server";

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

function parsed(over: Partial<ReturnType<typeof import("./gmail.server").parseMessage>> = {}) {
  return {
    gmail_message_id: over.gmail_message_id ?? "g-1",
    thread_id: over.thread_id ?? "t-1",
    from_addr: over.from_addr ?? "sender@example.com",
    from_name: over.from_name ?? "",
    to_addrs: over.to_addrs ?? "me@example.com",
    cc: over.cc ?? "",
    list_id: over.list_id ?? "",
    in_reply_to: over.in_reply_to ?? "",
    subject: over.subject ?? "",
    snippet: over.snippet ?? "",
    body_text: over.body_text ?? "",
    body_html: over.body_html ?? "",
    received_at: over.received_at ?? new Date().toISOString(),
    has_attachment: over.has_attachment ?? false,
    has_calendar_invite: over.has_calendar_invite ?? false,
    raw_labels: over.raw_labels ?? ["INBOX"],
    is_read: over.is_read ?? false,
  };
}

const job = {
  id: "job-1",
  gmail_account_id: "acc-1",
  gmail_message_id: "g-1",
  user_id: "user-1",
  attempt: 0,
  priority: 0,
  published_at_ms: null,
};

describe("buildCatchupRow", () => {
  it("drops messages with excluded labels (SENT/DRAFT/TRASH/SPAM/CHAT)", () => {
    const c = ctx();
    for (const label of ["SENT", "DRAFT", "TRASH", "SPAM", "CHAT"]) {
      expect(buildCatchupRow(job, parsed({ raw_labels: [label] }), c)).toBeNull();
    }
  });

  it("rule-matched mail: row carries final folder_id, no pending_ai", () => {
    const f = folder({ id: "f1", name: "Work" });
    const c = ctx({
      folders: [f],
      filters: [filter("f1", "from", "contains", "@acme.com")],
      enrichedFolders: [{ id: "f1", name: "Work", ai_rule: null }],
    });
    const built = buildCatchupRow(job, parsed({ from_addr: "billing@acme.com" }), c);
    expect(built).not.toBeNull();
    expect(built!.needs_ai).toBe(false);
    expect(built!.folder_id).toBe("f1");
    expect(built!.upsert.classified_by).toBe("filter");
    expect(built!.update!.folder_id).toBe("f1");
  });

  it("rule-matched mail with auto_archive: is_archived true in INSERT (no flicker)", () => {
    const f = folder({ id: "f1", name: "Newsletters", auto_archive: true });
    const c = ctx({
      folders: [f],
      filters: [filter("f1", "from", "contains", "@news.test")],
      enrichedFolders: [{ id: "f1", name: "Newsletters", ai_rule: null }],
    });
    const built = buildCatchupRow(
      job,
      parsed({ from_addr: "a@news.test", raw_labels: ["INBOX"] }),
      c,
    );
    expect(built!.upsert.is_archived).toBe(true);
    expect(built!.update!.folder_id).toBe("f1");
  });

  it("rule-matched mail with auto_mark_read: is_read true in INSERT", () => {
    const f = folder({ id: "f1", name: "Promo", auto_mark_read: true });
    const c = ctx({
      folders: [f],
      filters: [filter("f1", "subject", "contains", "sale")],
      enrichedFolders: [{ id: "f1", name: "Promo", ai_rule: null }],
    });
    const built = buildCatchupRow(job, parsed({ subject: "Big sale", is_read: false }), c);
    expect(built!.upsert.is_read).toBe(true);
  });

  it("no rule matches + AI candidates exist: row is pending_ai, folder null", () => {
    const f = folder({ id: "f1", name: "Work" });
    const c = ctx({
      folders: [f],
      enrichedFolders: [{ id: "f1", name: "Work", ai_rule: null }],
    });
    const built = buildCatchupRow(job, parsed({ from_addr: "nobody@nowhere.test" }), c);
    expect(built!.needs_ai).toBe(true);
    expect(built!.folder_id).toBeNull();
    expect(built!.upsert.classified_by).toBe("pending_ai");
  });

  it("inbox_override (allowlist) stays terminal — AI must NOT route into a folder", () => {
    const f = folder({ id: "f1", name: "Work" });
    const c = ctx({
      folders: [f],
      overrides: [{ id: "o1", match_type: "domain", value: "vip.example" }],
      enrichedFolders: [{ id: "f1", name: "Work", ai_rule: null }],
    });
    const built = buildCatchupRow(job, parsed({ from_addr: "ceo@vip.example" }), c);
    expect(built!.needs_ai).toBe(false);
    expect(built!.upsert.classified_by).toBe("inbox_override");
    expect(built!.folder_id).toBeNull();
  });
});
