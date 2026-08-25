// The precedence ladder, locked rung by rung.
//
// decideFolder is the ONE place that answers "which folder does this
// email belong in". These tests are table-driven on purpose: each row is
// a rung of the ladder, so a future change that reorders precedence for
// one trigger (label change, manual move, backfill) fails here instead of
// silently misfiling mail on that one path.
import { describe, it, expect } from "vitest";
import { decideFolder, type DecisionTrigger } from "./decide-folder";
import type { AccountContext } from "./account-context";
import type { Filter, Folder, InboxOverride } from "./types";
import type { ParsedEmailForClassify } from "./classify";

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
    processing_enabled: true,
    ...over,
  } as Folder;
}

function filter(folder_id: string, field: string, op: string, value: string): Filter {
  return {
    id: `${folder_id}-${field}-${op}-${value}`,
    folder_id,
    field,
    op,
    value,
  } as unknown as Filter;
}

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
    senderGroups: new Map<string, string[]>(),
    ...over,
  } as unknown as AccountContext;
}

const parsed: ParsedEmailForClassify = {
  from_addr: "billing@stripe.com",
  from_name: "Stripe",
  to_addrs: "me@example.com",
  subject: "Your invoice is ready",
  snippet: "",
  body_text: "invoice attached",
  body_html: "",
  has_attachment: false,
  received_at: "2026-07-21T00:00:00Z",
  raw_labels: ["INBOX"],
};

const invoices = folder({ id: "f-inv", name: "Invoices", gmail_label_id: "Label_9" });
const invoiceFilter = filter("f-inv", "subject", "contains", "invoice");
const triggers: DecisionTrigger[] = ["arrival", "backfill", "rescue", "reanalyze", "label_change"];

describe("decideFolder precedence", () => {
  it("rung 1: a paused folder is never a destination, on any trigger", () => {
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

  it("rung 1 beats a manual move too", () => {
    const paused = folder({ ...invoices, processing_enabled: false });
    const r = decideFolder(parsed, context({ folders: [paused] }), {
      trigger: "manual",
      manualFolderId: paused.id,
    });
    expect(r.folder_id).toBeNull();
  });

  it("rung 2: an exclude rule vetoes the folder even when its Gmail label is present", () => {
    const ctx = context({
      folders: [invoices],
      filters: [invoiceFilter, filter("f-inv", "body", "not_contains", "attached")],
    });
    const r = decideFolder(parsed, ctx, { trigger: "label_change", labeledFolderId: "f-inv" });
    expect(r.folder_id).toBeNull();
    expect(r.trace?.candidates.find((c) => c.folder_id === "f-inv")?.verdict).toBe("excluded");
  });

  it("rung 3: an always-inbox override wins over a filter match", () => {
    const overrides = [
      { id: "o1", kind: "domain", value: "stripe.com" },
    ] as unknown as InboxOverride[];
    const r = decideFolder(parsed, context({ folders: [invoices], filters: [invoiceFilter], overrides }), {
      trigger: "arrival",
    });
    expect(r.folder_id).toBeNull();
    expect(r.classified_by).toBe("inbox_override");
  });

  it("rung 3: a folder with overrides_inbox_override opts out of the override", () => {
    const overrides = [
      { id: "o1", kind: "domain", value: "stripe.com" },
    ] as unknown as InboxOverride[];
    const strong = folder({ ...invoices, overrides_inbox_override: true });
    const r = decideFolder(parsed, context({ folders: [strong], filters: [invoiceFilter], overrides }), {
      trigger: "arrival",
    });
    expect(r.folder_id).toBe("f-inv");
  });

  it("rung 4: a linked Gmail label routes before filters are consulted", () => {
    const labeled = { ...parsed, raw_labels: ["INBOX", "Label_9"] };
    const r = decideFolder(labeled, context({ folders: [invoices] }), { trigger: "arrival" });
    expect(r.folder_id).toBe("f-inv");
    expect(r.classified_by).toBe("gmail_label");
  });

  it("rung 5: highest priority wins among matching folders, and the trace says why", () => {
    const receipts = folder({ id: "f-rec", name: "Receipts", priority: 5, gmail_label_id: null });
    const ctx = context({
      folders: [folder({ ...invoices, gmail_label_id: null }), receipts],
      filters: [invoiceFilter, filter("f-rec", "subject", "contains", "invoice")],
    });
    const r = decideFolder(parsed, ctx, { trigger: "arrival" });
    expect(r.folder_id).toBe("f-rec");
    expect(r.classified_by).toBe("filter");
    expect(r.matched_folder_ids).toContain("f-inv");
    expect(r.trace?.tiebreak).toBeTruthy();
  });

  it("rung 7: AI is only pending for folders that carry an ai_rule", () => {
    const noRule = decideFolder(parsed, context({ folders: [folder({ gmail_label_id: null })] }), {
      trigger: "arrival",
    });
    expect(noRule.needs_ai).toBe(false);

    const withRule = decideFolder(
      parsed,
      context({ folders: [folder({ gmail_label_id: null, ai_rule: "invoices and billing" })] }),
      { trigger: "arrival" },
    );
    expect(withRule.needs_ai).toBe(true);
  });

  it("rung 8: filing into a folder with a surface rule requests the surface check", () => {
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

  it("rung 9: nothing matched leaves the message in the inbox", () => {
    const r = decideFolder(parsed, context({ folders: [] }), { trigger: "arrival" });
    expect(r.folder_id).toBeNull();
    expect(r.classified_by).toBe("none");
    expect(r.needs_ai).toBe(false);
  });

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
