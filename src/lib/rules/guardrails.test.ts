import { describe, expect, it } from "vitest";
import { evaluateGuardrails, isSecurityMessage } from "./guardrails";
import type { EngineMessage, Guardrail } from "./types";

const msg = (over: Partial<EngineMessage> = {}): EngineMessage => ({
  from_addr: "noreply@bank.com",
  from_name: "Bank",
  to_addrs: "me@example.com",
  subject: "Hello",
  body_text: "nothing special",
  has_attachment: false,
  ...over,
});

describe("isSecurityMessage", () => {
  const hits = [
    "Your verification code is 402113",
    "One-time passcode for sign-in",
    "Two-factor authentication requested",
    "402113 is your login code",
    "Verify your email address",
  ];
  for (const subject of hits) {
    it(`flags "${subject}"`, () => {
      expect(isSecurityMessage(msg({ subject }))).toBe(true);
    });
  }

  it("does not flag ordinary mail", () => {
    expect(isSecurityMessage(msg({ subject: "Your weekly newsletter" }))).toBe(false);
  });

  it("checks the top of the body too", () => {
    expect(
      isSecurityMessage(msg({ subject: "Action needed", body_text: "Your code is 991122" })),
    ).toBe(true);
  });
});

describe("evaluateGuardrails", () => {
  it("pins to the Inbox on a protected sender", () => {
    const guardrails: Guardrail[] = [
      { id: "g", scope: "global", kind: "protected_sender", label: "bank.com" },
    ];
    const res = evaluateGuardrails(msg(), guardrails);
    expect(res.verdict.kind).toBe("pin_inbox");
  });

  it("collects folder-scoped exclusions instead of pinning", () => {
    const guardrails: Guardrail[] = [
      {
        id: "g",
        scope: "folder",
        kind: "exclusion",
        folder_id: "f1",
        condition: { field: "subject", op: "not_contains", value: "Hello" },
      },
    ];
    const res = evaluateGuardrails(msg(), guardrails);
    expect(res.verdict.kind).toBe("none");
    expect(res.vetoedFolderIds).toEqual(["f1"]);
  });

  it("accepts an injected detector", () => {
    const res = evaluateGuardrails(msg(), [], () => true);
    expect(res.verdict.kind).toBe("security");
  });
});
