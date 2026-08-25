// The golden set (Amendment 5, Phase E).
//
// Each case pins one behaviour the engine must never regress. They are
// written against a small synthetic mailbox rather than real mail so the
// set can live in the repo and be read in a diff.
//
// Adding a case is cheap. Changing an expectation is a deliberate act:
// it means the precedence itself changed and the reason belongs in the
// commit message.
import type { EngineMessage, EvaluateContext, Guardrail, Rule } from "./types";

export const GOLDEN_FOLDERS = {
  receipts: "11111111-1111-1111-1111-111111111111",
  newsletters: "22222222-2222-2222-2222-222222222222",
  vendor: "33333333-3333-3333-3333-333333333333",
  paused: "44444444-4444-4444-4444-444444444444",
} as const;

const rule = (
  id: string,
  folder_id: string,
  groups: Rule["groups"],
  created_at = "2026-01-01T00:00:00.000Z",
): Rule => ({ id, folder_id, created_at, groups });

const GOLDEN_RULES: Rule[] = [
  // L1: the exact billing sender.
  rule("r-receipts-sender", GOLDEN_FOLDERS.receipts, [
    [{ field: "from", op: "contains", value: "billing@netflix.com" }],
  ]),
  // L2: one exact domain.
  rule("r-vendor-domain", GOLDEN_FOLDERS.vendor, [
    [{ field: "domain", op: "equals", value: "acmesupply.com" }],
  ]),
  // L5: a content rule that deliberately overlaps the two above, to prove
  // the ladder — not authoring order — decides.
  rule("r-newsletters-content", GOLDEN_FOLDERS.newsletters, [
    [{ field: "subject", op: "contains", value: "newsletter" }],
  ]),
  // L4: structural, mailing-list mail.
  rule("r-newsletters-list", GOLDEN_FOLDERS.newsletters, [
    [{ field: "list_id", op: "contains", value: "list.example.com" }],
  ]),
  // A rule on a paused folder: must never file anything.
  rule("r-paused", GOLDEN_FOLDERS.paused, [
    [{ field: "from", op: "contains", value: "paused@example.com" }],
  ]),
];

const GOLDEN_GUARDRAILS: Guardrail[] = [
  {
    id: "g-vendor-exclusion",
    scope: "folder",
    kind: "exclusion",
    folder_id: GOLDEN_FOLDERS.vendor,
    condition: { field: "subject", op: "not_contains", value: "invoice" },
    label: "vendor folder only takes invoices",
  },
  {
    id: "g-protected",
    scope: "global",
    kind: "protected_sender",
    label: "accountant@firm.com",
  },
];

export const goldenContext = (): EvaluateContext => ({
  folders: [
    { id: GOLDEN_FOLDERS.receipts, name: "Receipts", description: "receipts and payments" },
    { id: GOLDEN_FOLDERS.newsletters, name: "Newsletters", description: "bulk mail" },
    { id: GOLDEN_FOLDERS.vendor, name: "Vendor", description: "vendor invoices" },
    { id: GOLDEN_FOLDERS.paused, name: "Paused folder", processing_enabled: false },
  ],
  rules: GOLDEN_RULES,
  pins: [{ id: "p-inbox", kind: "inbox", match: "email", value: "ceo@bigclient.com" }],
  guardrails: GOLDEN_GUARDRAILS,
});

const message = (over: Partial<EngineMessage>): EngineMessage => ({
  from_addr: "someone@example.com",
  from_name: "Someone",
  to_addrs: "me@example.com",
  subject: "Hello",
  body_text: "",
  has_attachment: false,
  ...over,
});

import type { GoldenCase } from "./golden";

export const GOLDEN_CASES: GoldenCase[] = [
  {
    id: "l1-beats-l5",
    intent: "an exact-sender rule outranks a content rule that also matches",
    message: message({
      from_addr: "billing@netflix.com",
      from_name: "Netflix",
      subject: "Your monthly newsletter and receipt",
    }),
    expect_folder_id: GOLDEN_FOLDERS.receipts,
    expect_stage: "rule",
  },
  {
    id: "l2-beats-l5",
    intent: "an exact-domain rule outranks a content rule",
    message: message({
      from_addr: "orders@acmesupply.com",
      subject: "Your invoice — newsletter edition",
    }),
    expect_folder_id: GOLDEN_FOLDERS.vendor,
    expect_stage: "rule",
  },
  {
    id: "l4-beats-l5",
    intent: "a structural list-id rule outranks a subject rule",
    message: message({
      from_addr: "digest@news.example.com",
      subject: "Weekly newsletter",
      list_id: "<weekly.list.example.com>",
    }),
    expect_folder_id: GOLDEN_FOLDERS.newsletters,
    expect_stage: "rule",
  },
  {
    id: "content-rule-still-files",
    intent: "a content rule files mail nothing more specific claims",
    message: message({ from_addr: "hello@random.io", subject: "Our June newsletter" }),
    expect_folder_id: GOLDEN_FOLDERS.newsletters,
    expect_stage: "rule",
  },
  {
    id: "folder-exclusion-vetoes",
    intent: "a folder exclusion disqualifies the folder even when its rule matches",
    message: message({ from_addr: "orders@acmesupply.com", subject: "Shipping update" }),
    expect_folder_id: null,
    expect_stage: "inbox",
  },
  {
    id: "security-code-stays-in-inbox",
    intent: "a 2FA code is never filed",
    message: message({
      from_addr: "billing@netflix.com",
      subject: "Your verification code is 448122",
    }),
    expect_folder_id: null,
    expect_stage: "guardrail",
  },
  {
    id: "protected-sender-stays-in-inbox",
    intent: "a protected sender beats every rule",
    message: message({ from_addr: "accountant@firm.com", subject: "June newsletter" }),
    expect_folder_id: null,
    expect_stage: "guardrail",
  },
  {
    id: "inbox-pin-stays-in-inbox",
    intent: "an always-inbox pin beats a matching content rule",
    message: message({ from_addr: "ceo@bigclient.com", subject: "newsletter thoughts" }),
    expect_folder_id: null,
    expect_stage: "pin",
  },
  {
    id: "paused-folder-never-files",
    intent: "a paused folder is inert even with a matching rule",
    message: message({ from_addr: "paused@example.com", subject: "anything" }),
    expect_folder_id: null,
    expect_stage: "inbox",
  },
  {
    id: "no-rule-no-ai-stays-in-inbox",
    intent: "with the AI stage off, unmatched mail stays in the Inbox",
    message: message({ from_addr: "stranger@nowhere.test", subject: "Quick question" }),
    expect_folder_id: null,
    expect_stage: "inbox",
  },
];
