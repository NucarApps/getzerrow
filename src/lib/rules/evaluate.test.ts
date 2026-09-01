import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate";
import type { EngineFolder, EngineMessage, EvaluateContext, Guardrail, Pin, Rule } from "./types";

const folders: EngineFolder[] = [
  { id: "receipts", name: "Receipts", description: "Order receipts and invoices" },
  { id: "shipping", name: "Shipping", description: "Delivery updates" },
  { id: "labeled", name: "Labeled", gmail_label_id: "Label_1" },
  { id: "paused", name: "Paused", processing_enabled: false, description: "off" },
  { id: "noai", name: "No AI", skip_ai: true, description: "never" },
];

const msg = (over: Partial<EngineMessage> = {}): EngineMessage => ({
  from_addr: "billing@amazon.com",
  from_name: "Amazon Billing",
  to_addrs: "me@example.com",
  subject: "Your order receipt",
  body_text: "thanks for shopping",
  has_attachment: false,
  thread_id: "t1",
  raw_labels: [],
  ...over,
});

const domainRule: Rule = {
  id: "domain",
  folder_id: "receipts",
  created_at: "2026-01-01T00:00:00.000Z",
  groups: [[{ field: "domain", op: "contains", value: "amazon.com" }]],
};

const ctx = (over: Partial<EvaluateContext> = {}): EvaluateContext => ({
  folders,
  rules: [],
  pins: [],
  guardrails: [],
  ...over,
});

const opts = { trigger: "arrival" as const, aiEnabled: true };

describe("evaluate — stage order (Amendment 1)", () => {
  it("stage 1 guardrail pins a 2FA code to the Inbox even when a rule matches", () => {
    const res = evaluate(
      msg({ subject: "Your verification code is 402113" }),
      ctx({ rules: [domainRule] }),
      opts,
    );
    expect(res.folder_id).toBeNull();
    expect(res.stage).toBe("guardrail");
    expect(res.needs_ai).toBe(false);
  });

  it("stage 1 protected sender beats a matching Gmail label", () => {
    const guardrails: Guardrail[] = [
      { id: "g", scope: "global", kind: "protected_sender", label: "billing@amazon.com" },
    ];
    const res = evaluate(msg({ raw_labels: ["Label_1"] }), ctx({ guardrails }), opts);
    expect(res.stage).toBe("guardrail");
    expect(res.folder_id).toBeNull();
  });

  it("a folder-scoped exclusion vetoes that folder without pinning the message", () => {
    const guardrails: Guardrail[] = [
      {
        id: "g",
        scope: "folder",
        kind: "exclusion",
        folder_id: "receipts",
        condition: { field: "subject", op: "not_contains", value: "receipt" },
      },
    ];
    const res = evaluate(msg(), ctx({ rules: [domainRule], guardrails }), opts);
    expect(res.folder_id).toBeNull();
    expect(res.trace.vetoed_folder_ids).toEqual(["receipts"]);
    expect(res.stage).toBe("ai");
  });

  it("stage 2 inbox pin beats the Gmail label mirror", () => {
    const pins: Pin[] = [{ id: "p", kind: "inbox", match: "domain", value: "amazon.com" }];
    const res = evaluate(msg({ raw_labels: ["Label_1"] }), ctx({ pins }), opts);
    expect(res.stage).toBe("pin");
    expect(res.folder_id).toBeNull();
  });

  it("stage 2 folder pin beats hard rules", () => {
    const pins: Pin[] = [
      {
        id: "p",
        kind: "folder",
        match: "email",
        value: "billing@amazon.com",
        folder_id: "shipping",
      },
    ];
    const res = evaluate(msg(), ctx({ pins, rules: [domainRule] }), opts);
    expect(res.stage).toBe("pin");
    expect(res.folder_id).toBe("shipping");
  });

  it("a pin to a paused folder falls through to the rules stage", () => {
    const pins: Pin[] = [
      { id: "p", kind: "folder", match: "domain", value: "amazon.com", folder_id: "paused" },
    ];
    const res = evaluate(msg(), ctx({ pins, rules: [domainRule] }), opts);
    expect(res.stage).toBe("rule");
    expect(res.folder_id).toBe("receipts");
  });

  it("stage 3 files a message Gmail already labeled", () => {
    const res = evaluate(msg({ raw_labels: ["Label_1"] }), ctx({ rules: [domainRule] }), opts);
    expect(res.stage).toBe("gmail_label");
    expect(res.folder_id).toBe("labeled");
  });

  it("a paused folder's Gmail label does not file mail", () => {
    const paused: EngineFolder[] = [
      { id: "labeled", name: "Labeled", gmail_label_id: "Label_1", processing_enabled: false },
    ];
    const res = evaluate(msg({ raw_labels: ["Label_1"] }), ctx({ folders: paused }), opts);
    expect(res.folder_id).toBeNull();
    expect(res.stage).toBe("inbox");
  });

  it("stage 4 follows a user placement earlier in the thread", () => {
    const res = evaluate(
      msg(),
      ctx({ rules: [domainRule], threadDecision: { folder_id: "shipping", provenance: "user" } }),
      opts,
    );
    expect(res.stage).toBe("thread_continuity");
    expect(res.folder_id).toBe("shipping");
  });

  it("stage 4 never chains off an unconfirmed AI decision", () => {
    const res = evaluate(
      msg(),
      ctx({ rules: [domainRule], threadDecision: { folder_id: "shipping", provenance: "ai" } }),
      opts,
    );
    expect(res.stage).toBe("rule");
    expect(res.folder_id).toBe("receipts");
  });

  it("stage 5 records the winning rule and its level in the trace", () => {
    const res = evaluate(msg(), ctx({ rules: [domainRule] }), opts);
    expect(res.stage).toBe("rule");
    expect(res.trace.winner).toMatchObject({ rule_id: "domain", level: 3 });
    expect(res.trace.matched_rules).toHaveLength(1);
  });

  it("stage 6 only runs when stage 5 returned nothing", () => {
    const res = evaluate(msg({ from_addr: "someone@unknown.com" }), ctx(), opts);
    expect(res.stage).toBe("ai");
    expect(res.needs_ai).toBe(true);
    expect(res.ai_candidate_folder_ids).toEqual(["receipts", "shipping"]);
  });

  it("AI is disabled for backfill, reprocess and replay", () => {
    for (const trigger of ["backfill", "reprocess", "replay"] as const) {
      const res = evaluate(msg({ from_addr: "someone@unknown.com" }), ctx(), {
        trigger,
        aiEnabled: false,
      });
      expect(res.needs_ai).toBe(false);
      expect(res.stage).toBe("inbox");
    }
  });

  it("stage 7 leaves unmatched mail in the Inbox", () => {
    const res = evaluate(
      msg({ from_addr: "someone@unknown.com" }),
      ctx({ folders: [{ id: "noai", name: "No AI", skip_ai: true, description: "x" }] }),
      opts,
    );
    expect(res.stage).toBe("inbox");
    expect(res.folder_id).toBeNull();
  });

  it("records a collision without going silent", () => {
    const rules: Rule[] = [
      domainRule,
      {
        id: "domain2",
        folder_id: "shipping",
        created_at: "2026-06-01T00:00:00.000Z",
        groups: [[{ field: "domain", op: "contains", value: "amazon.com" }]],
      },
    ];
    const res = evaluate(msg(), ctx({ rules }), opts);
    expect(res.folder_id).toBe("receipts");
    expect(res.trace.collision).toMatchObject({ winner_rule_id: "domain", level: 3 });
  });

  it("is deterministic: identical inputs produce an identical trace", () => {
    const a = evaluate(msg(), ctx({ rules: [domainRule] }), opts);
    const b = evaluate(msg(), ctx({ rules: [domainRule] }), opts);
    expect(a).toEqual(b);
  });

  it("skipGmailLabelMatch re-derives the folder from rules", () => {
    const res = evaluate(msg({ raw_labels: ["Label_1"] }), ctx({ rules: [domainRule] }), {
      trigger: "reprocess",
      aiEnabled: false,
      skipGmailLabelMatch: true,
    });
    expect(res.stage).toBe("rule");
    expect(res.folder_id).toBe("receipts");
  });
});
