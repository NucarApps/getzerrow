import { describe, expect, it } from "vitest";
import type { Filter, HistoryEmail } from "@/components/folders/editor/types";
import { describeReason, getReasonMeta, matchFilter, relativeTime } from "./folder-history";

function email(over: Partial<HistoryEmail> = {}): HistoryEmail {
  return {
    id: "e-1",
    subject: "Invoice 42",
    from_addr: "billing@acme.com",
    from_name: "Acme Billing",
    received_at: "2026-09-01T11:00:00.000Z",
    classified_by: null,
    ai_confidence: null,
    ai_summary: null,
    snippet: "Your invoice is attached.",
    ...over,
  };
}

function filter(over: Partial<Filter> = {}): Filter {
  return { id: "f-1", folder_id: "fo-1", field: "from", op: "contains", value: "acme", ...over };
}

describe("getReasonMeta", () => {
  it.each([
    ["ai", "AI", "ai"],
    ["manual_move", "Manual", "manual"],
    ["filter", "Rule", "rule"],
    ["domain_rule", "Domain rule", "rule"],
    ["gmail_label", "Gmail label", "label"],
    ["surfaced_to_inbox", "Surfaced", "label"],
    ["none", "Imported", "muted"],
  ])("labels %s as %s", (by, label, tone) => {
    expect(getReasonMeta(by)).toStrictEqual({ label, tone });
  });

  it("falls back to Imported for an email with no classifier stamp", () => {
    expect(getReasonMeta(null)).toStrictEqual({ label: "Imported", tone: "muted" });
    expect(getReasonMeta(undefined)).toStrictEqual({ label: "Imported", tone: "muted" });
  });

  it("falls back to Imported for a classifier this panel has no word for", () => {
    // Production also stamps ai_low_confidence, ai_error, thread_continuity,
    // unclassified and manual_inbox; none of them has a badge here.
    expect(getReasonMeta("ai_low_confidence")).toStrictEqual({ label: "Imported", tone: "muted" });
  });

  it("does not pick up inherited Object properties for a made-up value", () => {
    expect(getReasonMeta("constructor")).toStrictEqual({ label: "Imported", tone: "muted" });
  });
});

describe("matchFilter — which rule is reported", () => {
  it("returns the rule that matches", () => {
    const f = filter({ field: "subject", op: "contains", value: "invoice" });
    expect(matchFilter(email(), [f])).toStrictEqual(f);
  });

  it("returns null when the folder has no rules at all", () => {
    expect(matchFilter(email(), [])).toBeNull();
  });

  it("returns null when a rule was deleted after it filed the email", () => {
    // The panel only ever sees the folder's CURRENT rules, so a rule the user
    // has since removed leaves no candidate and the panel says so vaguely
    // rather than naming the wrong rule.
    expect(matchFilter(email(), [filter({ field: "subject", value: "receipt" })])).toBeNull();
  });

  it("reports the first matching rule when several match", () => {
    const first = filter({ id: "f-a", field: "from", value: "acme" });
    const second = filter({ id: "f-b", field: "subject", value: "invoice" });
    expect(matchFilter(email(), [first, second])?.id).toBe("f-a");
  });

  it("skips a rule with an empty value rather than matching everything on it", () => {
    const empty = filter({ id: "f-empty", field: "subject", op: "contains", value: "" });
    const real = filter({ id: "f-real", field: "subject", op: "contains", value: "invoice" });
    expect(matchFilter(email(), [empty, real])?.id).toBe("f-real");
  });

  it("matches the snippet against body rules, since the body is not loaded here", () => {
    expect(
      matchFilter(email({ snippet: "wire transfer details" }), [
        filter({ field: "body", op: "contains", value: "wire transfer" }),
      ])?.id,
    ).toBe("f-1");
  });

  it("treats a legacy 'snippet' rule field as the body", () => {
    expect(
      matchFilter(email({ snippet: "wire transfer details" }), [
        filter({ field: "snippet", op: "contains", value: "wire transfer" }),
      ])?.id,
    ).toBe("f-1");
  });

  it("defaults a rule with no operator to contains", () => {
    expect(matchFilter(email(), [filter({ field: "subject", op: "", value: "invoice" })])?.id).toBe(
      "f-1",
    );
  });

  it("matches the from field against the address and the display name together", () => {
    expect(
      matchFilter(email(), [filter({ field: "from", op: "contains", value: "acme billing" })])?.id,
    ).toBe("f-1");
  });

  it("matches a domain rule against the sender's domain", () => {
    expect(
      matchFilter(email(), [filter({ field: "domain", op: "equals", value: "acme.com" })])?.id,
    ).toBe("f-1");
  });

  it("survives an email with every text field null", () => {
    const blank = email({ subject: null, from_addr: null, from_name: null, snippet: null });
    expect(matchFilter(blank, [filter({ field: "subject", value: "invoice" })])).toBeNull();
  });

  it("does not match a rule on a field the history panel never loads", () => {
    // `to`/`cc`/`list_id` are not in the history row, so a positive rule on
    // them cannot be confirmed and must not be reported as the cause.
    expect(
      matchFilter(email(), [filter({ field: "to", op: "contains", value: "me@example.com" })]),
    ).toBeNull();
  });

  // CHARACTERIZATION(folder-history-reports-exclude-rule): an exclude-op rule can never file mail, but the panel reports it as the cause — flip when fixed
  it("reports an exclude-op rule as the cause even though such a rule never files mail", () => {
    // The engine partitions a folder's rules into includes and excludes and
    // only an include can put mail in the folder (filter-engine EXCLUDE_OPS).
    // matchFilter does not partition, so `subject not_contains receipt` —
    // true for this email merely because it is not vetoed — is named as the
    // rule that filed it, ahead of the include rule that actually did.
    const veto = filter({ id: "f-veto", field: "subject", op: "not_contains", value: "receipt" });
    const real = filter({ id: "f-real", field: "subject", op: "contains", value: "invoice" });
    expect(matchFilter(email(), [veto, real])?.id).toBe("f-veto");
  });
});

describe("describeReason", () => {
  it("quotes the AI's own summary and reports its confidence", () => {
    expect(
      describeReason(
        email({ classified_by: "ai", ai_confidence: 0.82, ai_summary: "Looks like a bill" }),
        [],
      ),
    ).toStrictEqual({
      title: "Classified by AI · 82% confidence",
      body: { kind: "ai_summary", summary: "Looks like a bill" },
    });
  });

  it("omits the confidence clause when none was recorded", () => {
    expect(describeReason(email({ classified_by: "ai", ai_summary: "x" }), []).title).toBe(
      "Classified by AI",
    );
  });

  it("reports a zero confidence rather than hiding it as missing", () => {
    expect(
      describeReason(email({ classified_by: "ai", ai_confidence: 0, ai_summary: "x" }), []).title,
    ).toBe("Classified by AI · 0% confidence");
  });

  it("says no reason was recorded when the AI stored no summary", () => {
    expect(
      describeReason(email({ classified_by: "ai", ai_confidence: 0.5 }), []).body,
    ).toStrictEqual({ kind: "ai_no_reason" });
  });

  it("explains a manual move without pretending a classifier ran", () => {
    expect(describeReason(email({ classified_by: "manual_move" }), [])).toStrictEqual({
      title: "Moved here manually",
      body: { kind: "manual" },
    });
  });

  it("names the matching rule for a rule-filed email", () => {
    const f = filter({ field: "subject", op: "contains", value: "invoice" });
    expect(describeReason(email({ classified_by: "filter" }), [f])).toStrictEqual({
      title: "Matched a folder rule",
      body: { kind: "rule_matched", filter: f },
    });
  });

  it("keeps the domain-rule title while still naming the rule", () => {
    const f = filter({ field: "domain", op: "equals", value: "acme.com" });
    expect(describeReason(email({ classified_by: "domain_rule" }), [f])).toStrictEqual({
      title: "Matched a domain rule",
      body: { kind: "rule_matched", filter: f },
    });
  });

  it("stays vague rather than wrong when the rule that filed it is gone", () => {
    expect(describeReason(email({ classified_by: "filter" }), [])).toStrictEqual({
      title: "Matched a folder rule",
      body: { kind: "rule_unnamed" },
    });
  });

  it("explains a Gmail-label import", () => {
    expect(describeReason(email({ classified_by: "gmail_label" }), [])).toStrictEqual({
      title: "Imported from Gmail label",
      body: { kind: "gmail_label" },
    });
  });

  it("explains an email that no classifier has touched", () => {
    expect(describeReason(email({ classified_by: null }), [])).toStrictEqual({
      title: "Imported with this folder",
      body: { kind: "imported" },
    });
  });

  // CHARACTERIZATION(folder-history-surfaced-reason-blank): the surfaced-to-inbox explanation contradicts its own badge — flip when fixed
  it("claims no classifier ran on an email the surface check filed", () => {
    // The badge for this email reads "Surfaced" (getReasonMeta above), but
    // the expanded explanation falls through to the imported-with-the-folder
    // branch, so the panel contradicts itself about the same email.
    expect(describeReason(email({ classified_by: "surfaced_to_inbox" }), [])).toStrictEqual({
      title: "Imported with this folder",
      body: { kind: "imported" },
    });
  });

  it("falls through to imported for a classifier value with no branch", () => {
    expect(describeReason(email({ classified_by: "ai_low_confidence" }), []).title).toBe(
      "Imported with this folder",
    );
  });
});

describe("relativeTime", () => {
  const NOW = Date.parse("2026-09-01T12:00:00.000Z");
  const at = (ms: number) => new Date(NOW - ms).toISOString();

  it("renders nothing for a missing timestamp", () => {
    expect(relativeTime(null, NOW)).toBe("");
  });

  it.each([
    ["under a minute", 30_000, "just now"],
    ["exactly a minute", 60_000, "1m ago"],
    ["59 minutes", 59 * 60_000, "59m ago"],
    ["exactly an hour", 60 * 60_000, "1h ago"],
    ["23 hours", 23 * 3_600_000, "23h ago"],
    ["exactly a day", 24 * 3_600_000, "1d ago"],
    ["six days", 6 * 86_400_000, "6d ago"],
  ])("renders %s as %s", (_label, ago, expected) => {
    expect(relativeTime(at(ago), NOW)).toBe(expected);
  });

  it("switches to an absolute date at a week old", () => {
    expect(relativeTime(at(7 * 86_400_000), NOW)).toBe(
      new Date(NOW - 7 * 86_400_000).toLocaleDateString(),
    );
  });

  it("reads a future timestamp as just now rather than as a negative age", () => {
    expect(relativeTime(new Date(NOW + 60_000).toISOString(), NOW)).toBe("just now");
  });

  it("does not read the wall clock — the same timestamp ages as `now` advances", () => {
    const iso = at(0);
    expect(relativeTime(iso, NOW)).toBe("just now");
    expect(relativeTime(iso, NOW + 5 * 3_600_000)).toBe("5h ago");
  });
});
