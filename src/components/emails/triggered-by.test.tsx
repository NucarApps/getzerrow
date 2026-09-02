// Component tests for TriggeredBy — the "why is this email in this folder"
// explainer panel.
//
// Contracts under test:
//   * persisted matched_filter_ids pinpoint exactly the rule that fired,
//   * persisted ids whose rules were since deleted fall back to listing all
//     of the folder's rules with the "removed or edited" note,
//   * legacy emails (no persisted ids) re-run the include filters
//     client-side and only show the ones that actually match,
//   * the ai / unclassified branches render the prompt, the reason, or the
//     not-yet-classified fallback.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TriggeredBy } from "./triggered-by";

const email = (over: Partial<Parameters<typeof TriggeredBy>[0]["email"]> = {}) => ({
  from_addr: "billing@netflix.com",
  from_name: "Netflix",
  to_addrs: "serg@example.com",
  subject: "Your receipt",
  body_text: null,
  has_attachment: false,
  matched_filter_ids: null,
  ...over,
});

const folder = {
  id: "folder-1",
  name: "Receipts",
  ai_rule: null,
  gmail_label_id: null,
  filter_tree: null,
};

describe("TriggeredBy", () => {
  it("shows exactly the persisted rule that matched, not the folder's other rules", () => {
    render(
      <TriggeredBy
        classifiedBy="filter"
        reason={null}
        folder={folder}
        filters={[
          { id: "flt-1", field: "from", op: "contains", value: "netflix.com" },
          { id: "flt-2", field: "subject", op: "contains", value: "invoice" },
        ]}
        email={email({ matched_filter_ids: ["flt-1"] })}
      />,
    );
    expect(screen.getByText("Rule that matched")).toBeInTheDocument();
    expect(screen.getByText('"netflix.com"')).toBeInTheDocument();
    expect(screen.getByText("contains")).toBeInTheDocument();
    // The non-matching sibling rule stays hidden.
    expect(screen.queryByText('"invoice"')).not.toBeInTheDocument();
  });

  it("falls back to all rules with the 'removed or edited' note when persisted ids are stale", () => {
    render(
      <TriggeredBy
        classifiedBy="filter"
        reason={null}
        folder={folder}
        filters={[
          { id: "flt-1", field: "from", op: "contains", value: "netflix.com" },
          { id: "flt-2", field: "subject", op: "contains", value: "invoice" },
        ]}
        email={email({ matched_filter_ids: ["flt-gone"] })}
      />,
    );
    expect(
      screen.getByText(
        "The rule that originally matched this email has since been removed or edited.",
      ),
    ).toBeInTheDocument();
    // Both rules are listed as the fallback.
    expect(screen.getByText('"netflix.com"')).toBeInTheDocument();
    expect(screen.getByText('"invoice"')).toBeInTheDocument();
  });

  it("recomputes matches client-side for legacy emails and skips exclude ops", () => {
    render(
      <TriggeredBy
        classifiedBy="filter"
        reason={null}
        folder={folder}
        filters={[
          // Matches: domain of billing@netflix.com is netflix.com.
          { id: "flt-1", field: "domain", op: "equals", value: "netflix.com" },
          // Doesn't match the subject.
          { id: "flt-2", field: "subject", op: "contains", value: "invoice" },
          // Exclude op — would "match" (subject lacks "spam") but must be skipped.
          { id: "flt-3", field: "subject", op: "not_contains", value: "spam" },
        ]}
        email={email({ matched_filter_ids: null })}
      />,
    );
    expect(screen.getByText("Rule that matched")).toBeInTheDocument();
    expect(screen.getByText('"netflix.com"')).toBeInTheDocument();
    expect(screen.queryByText('"invoice"')).not.toBeInTheDocument();
    expect(screen.queryByText('"spam"')).not.toBeInTheDocument();
  });

  it.each([
    ["starts_with", "subject", "Your receipt"],
    ["ends_with", "subject", "receipt"],
  ])("recomputes a legacy match for a %s rule the engine supports", (op, field, value) => {
    // The client used to carry its own copy of the matcher, which knew
    // neither starts_with/ends_with nor domain_in — so mail filed by those
    // rules showed the "couldn't pinpoint" fallback instead of its rule.
    render(
      <TriggeredBy
        classifiedBy="filter"
        reason={null}
        folder={folder}
        filters={[{ id: "flt-1", field, op, value }]}
        email={email({ matched_filter_ids: null })}
      />,
    );
    expect(screen.getByText("Rule that matched")).toBeInTheDocument();
    expect(screen.getByText(`"${value}"`)).toBeInTheDocument();
    // Not the "showing all rules" fallback: the rule was pinpointed.
    expect(screen.queryByText(/Couldn't pinpoint the exact rule/)).not.toBeInTheDocument();
  });

  it("skips domain_in when recomputing: it is an allowlist veto, never an include", () => {
    render(
      <TriggeredBy
        classifiedBy="filter"
        reason={null}
        folder={folder}
        filters={[{ id: "flt-1", field: "domain", op: "domain_in", value: "netflix.com" }]}
        email={email({ matched_filter_ids: null })}
      />,
    );
    expect(screen.getByText(/Couldn't pinpoint the exact rule/)).toBeInTheDocument();
  });

  it("renders the folder AI prompt and reasoning for ai, and a fallback when unclassified", () => {
    const { rerender } = render(
      <TriggeredBy
        classifiedBy="ai"
        reason="Mentions a payment receipt."
        folder={{ ...folder, ai_rule: "Receipts and order confirmations" }}
        filters={[]}
        email={email()}
      />,
    );
    expect(screen.getByText("Folder AI prompt")).toBeInTheDocument();
    expect(screen.getByText('"Receipts and order confirmations"')).toBeInTheDocument();
    expect(screen.getByText("Mentions a payment receipt.")).toBeInTheDocument();

    rerender(
      <TriggeredBy classifiedBy={null} reason={null} folder={null} filters={[]} email={email()} />,
    );
    expect(screen.getByText("This email hasn't been classified yet.")).toBeInTheDocument();
  });
});
