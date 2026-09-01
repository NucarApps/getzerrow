// Component tests for the sentence-style rule editor.
//
// Contracts under test:
//   * an editor with no complete condition can't save and says so,
//   * free text typed into the draft box parses into the right condition
//     (an exact-domain rule here), shows up in the sentence and the ladder
//     badge, and is exactly what onSave receives,
//   * the debounced preview calls previewRuleChange with the full payload
//     and renders the match counts and samples,
//   * a blocking conflict renders its message and disables Save.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PreviewRuleChange } from "@/lib/rules/planner.functions";

vi.mock("@tanstack/react-start", () => ({
  useServerFn: <T,>(fn: T) => fn,
}));

const previewRuleChange = vi.fn();
const applyRuleChangeSet = vi.fn();
vi.mock("@/lib/rules/planner.functions", () => ({
  previewRuleChange: (...args: unknown[]) => previewRuleChange(...args),
  applyRuleChangeSet: (...args: unknown[]) => applyRuleChangeSet(...args),
  MAX_APPLIED_MOVES: 200,
}));

import { RuleSentenceEditor } from "./RuleSentenceEditor";

const makePreview = (over?: {
  conflicts?: Partial<PreviewRuleChange["conflicts"]>;
  change_set?: Partial<PreviewRuleChange["change_set"]>;
  headline?: string;
}): PreviewRuleChange => ({
  conflicts: {
    blocked: false,
    conflicts: [],
    candidate_match_count: 3,
    candidate_samples: [],
    candidate_level: 2,
    ...over?.conflicts,
  },
  change_set: {
    entries: [],
    move_count: 0,
    requires_review_count: 0,
    locked_count: 0,
    scanned: 120,
    summary: [],
    ...over?.change_set,
  },
  headline: over?.headline ?? "No existing mail changes folders.",
  level: 2,
  scanned: 120,
});

const baseProps = {
  accountId: "acct-1",
  folderId: "folder-1",
  folderName: "Receipts",
};

const renderEditor = (props: Partial<Parameters<typeof RuleSentenceEditor>[0]> = {}) => {
  const onSave = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RuleSentenceEditor {...baseProps} onSave={onSave} {...props} />
    </QueryClientProvider>,
  );
  return { onSave };
};

const draftInput = () =>
  screen.getByPlaceholderText("Type an address, a domain or a phrase and press Enter");
const valueInput = () => screen.getByPlaceholderText("billing@netflix.com");
const saveButton = () => screen.getByRole("button", { name: "Save rule" });

beforeEach(() => {
  vi.clearAllMocks();
  previewRuleChange.mockResolvedValue(makePreview());
});

describe("RuleSentenceEditor", () => {
  it("starts with no complete condition: save is disabled and the sentence says so", () => {
    renderEditor();
    expect(screen.getByText("Receipts")).toBeInTheDocument();
    expect(screen.getByText("Add a condition to get started.")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    // Nothing complete yet, so no preview request either.
    expect(previewRuleChange).not.toHaveBeenCalled();
  });

  it("parses a typed domain into an exact-domain condition and hands it to onSave", async () => {
    const user = userEvent.setup();
    const { onSave } = renderEditor();

    await user.type(draftInput(), "Acme.com{Enter}");

    // The sentence and ladder badge reflect the parsed condition.
    expect(screen.getByText('the sender\'s domain is exactly "acme.com"')).toBeInTheDocument();
    expect(screen.getByText("L2 exact domain")).toBeInTheDocument();

    await user.click(saveButton());
    // The untouched empty starter row is filtered out of what's saved.
    expect(onSave).toHaveBeenCalledWith([[{ field: "domain", op: "equals", value: "acme.com" }]]);
  });

  it("previews the debounced draft with the full payload and shows counts and samples", async () => {
    previewRuleChange.mockResolvedValue(
      makePreview({
        conflicts: {
          candidate_match_count: 3,
          candidate_samples: [
            {
              id: "m1",
              subject: "Your receipt",
              from_addr: "billing@netflix.com",
              received_at: null,
            },
          ],
        },
        change_set: { move_count: 2, summary: [{ from: "Inbox", to: "Receipts", count: 2 }] },
        headline: "Affects 2: 2 Inbox → Receipts",
      }),
    );
    const user = userEvent.setup();
    renderEditor();

    await user.type(valueInput(), "billing@netflix.com");

    // The preview settles after the 600ms debounce.
    expect(
      await screen.findByText("Matches 3 of 120 recent messages", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(previewRuleChange).toHaveBeenCalledWith({
      data: {
        account_id: "acct-1",
        folder_id: "folder-1",
        rule_id: null,
        replaces_rule_ids: [],
        groups: [[{ field: "from", op: "contains", value: "billing@netflix.com" }]],
        days: 90,
      },
    });
    expect(screen.getByText(/Your receipt/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Affects 2: 2 Inbox → Receipts" }),
    ).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it("renders a blocking conflict and refuses to save over it", async () => {
    previewRuleChange.mockResolvedValue(
      makePreview({
        conflicts: {
          blocked: true,
          candidate_match_count: 5,
          conflicts: [
            {
              kind: "block",
              rule_id: "r-9",
              folder_id: "folder-2",
              folder_name: "Newsletters",
              level: 2,
              candidate_level: 2,
              overlap_count: 5,
              samples: [],
              winner: "tie",
              message: "This rule ties with an existing rule for Newsletters.",
            },
          ],
        },
      }),
    );
    renderEditor({ initialGroups: [[{ field: "domain", op: "equals", value: "acme.com" }]] });

    await waitFor(
      () =>
        expect(
          screen.getByText("This rule ties with an existing rule for Newsletters."),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(saveButton()).toBeDisabled();

    // The conflict, not an empty sentence, is what's blocking: the rule itself is complete.
    expect(screen.getByText('the sender\'s domain is exactly "acme.com"')).toBeInTheDocument();
  });
});
