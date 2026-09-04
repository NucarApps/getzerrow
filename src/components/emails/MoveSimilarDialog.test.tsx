// MoveSimilarDialog — the follow-up offered after a single email is filed:
// "move the other mail like this too, and save a rule while you're here."
//
// It moves mail in bulk AND creates a routing rule in one confirm, so the
// contracts that matter are about the user knowing what they agreed to:
//
//   * everything found is pre-selected, so the action button always states
//     the count and destination it will actually act on,
//   * switching sender/domain refetches — the matches for one are not the
//     matches for the other, and reusing a stale list would move mail the
//     user never saw,
//   * the rule saved alongside the move follows the mode, and is omitted
//     rather than guessed when the email carries no address for it: a
//     `from` rule built from a null sender would match nothing,
//   * an in-flight fetch that resolves after the mode changed must not
//     overwrite the newer list,
//   * failures are surfaced and the dialog stays open, since the
//     selection is the user's work.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithQuery, mockReactStart, makeToastSpies } from "@/lib/__fixtures__/ui";

vi.mock("@tanstack/react-start", () => mockReactStart());

const { toast, module: sonnerModule } = makeToastSpies();
vi.mock("sonner", () => sonnerModule());

const findSimilarEmails = vi.fn();
const bulkMoveEmails = vi.fn();
vi.mock("@/lib/gmail.functions", () => ({
  findSimilarEmails: (...a: unknown[]) => findSimilarEmails(...a),
  bulkMoveEmails: (...a: unknown[]) => bulkMoveEmails(...a),
}));

const invalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => ({ invalidateQueries }) };
});

const { MoveSimilarDialog } = await import("./MoveSimilarDialog");

const onOpenChange = vi.fn();
const RECEIPTS = { id: "f2", name: "Receipts", color: "#222" };
const FOLDERS = [{ id: "f1", name: "Newsletters", color: "#111" }, RECEIPTS];

const match = (id: string, over: Partial<Record<string, string | null>> = {}) => ({
  id,
  subject: `Subject ${id}`,
  from_addr: "billing@acme.test",
  from_name: "Acme Billing",
  received_at: "2026-08-01T00:00:00.000Z",
  snippet: `Snippet ${id}`,
  ...over,
});

type Props = Parameters<typeof MoveSimilarDialog>[0];

function open(over: Partial<Props> = {}) {
  return renderWithQuery(
    <MoveSimilarDialog
      open
      onOpenChange={onOpenChange}
      emailId="e0"
      fromFolderId="f1"
      fromAddr="billing@acme.test"
      domain="acme.test"
      toFolder={RECEIPTS}
      folders={FOLDERS}
      {...over}
    />,
  );
}

const moveButton = () => screen.getByRole("button", { name: /^Move \d+ to / });
const moveData = () => (bulkMoveEmails.mock.calls[0]![0] as { data: Record<string, unknown> }).data;

beforeEach(() => {
  findSimilarEmails.mockResolvedValue({ matches: [match("e1"), match("e2")] });
  bulkMoveEmails.mockResolvedValue({ moved: 2, failed: 0 });
});

describe("finding matches", () => {
  it("looks in the folder the email came from, for the default mode", async () => {
    open();
    await waitFor(() => expect(findSimilarEmails).toHaveBeenCalled());
    expect(findSimilarEmails.mock.calls[0]![0]).toEqual({
      data: { email_id: "e0", from_folder_id: "f1", mode: "sender" },
    });
  });

  it("honours an explicit default mode", async () => {
    open({ defaultMode: "domain" });
    await waitFor(() =>
      expect(findSimilarEmails.mock.calls[0]![0]).toMatchObject({ data: { mode: "domain" } }),
    );
  });

  it("names the source folder, falling back for mail that had no rule", async () => {
    open({ fromFolderId: null });
    expect(await screen.findByText("No rules")).toBeInTheDocument();
  });

  it("says there is nothing to move rather than showing an empty list", async () => {
    findSimilarEmails.mockResolvedValue({ matches: [] });
    open();
    expect(await screen.findByText("No other matching emails in Newsletters.")).toBeInTheDocument();
    expect(moveButton()).toBeDisabled();
  });

  it("reports a failed search and leaves the list empty", async () => {
    findSimilarEmails.mockRejectedValue(new Error("search timed out"));
    open();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("search timed out"));
  });

  it("warns when the result list is capped", async () => {
    findSimilarEmails.mockResolvedValue({
      matches: Array.from({ length: 50 }, (_, i) => match(`e${i}`)),
    });
    open();
    expect(await screen.findByText("Showing the 50 most recent matches.")).toBeInTheDocument();
  });

  it("does not warn about a cap that was not reached", async () => {
    open();
    await screen.findByText("2 of 2 selected");
    expect(screen.queryByText(/50 most recent/)).not.toBeInTheDocument();
  });
});

describe("mode switching", () => {
  it("refetches for the other mode rather than reusing the list", async () => {
    // Sender matches are a subset of domain matches; reusing them would
    // move mail the user was never shown.
    const { user } = open();
    await screen.findByText("2 of 2 selected");

    findSimilarEmails.mockResolvedValue({ matches: [match("e9")] });
    await user.click(screen.getByRole("button", { name: /Same domain/ }));

    await waitFor(() => expect(screen.getByText("1 of 1 selected")).toBeInTheDocument());
    expect(findSimilarEmails).toHaveBeenLastCalledWith({
      data: { email_id: "e0", from_folder_id: "f1", mode: "domain" },
    });
  });

  it("offers no domain mode for an email with no domain", async () => {
    open({ domain: null });
    await screen.findByText("2 of 2 selected");
    expect(screen.getByRole("button", { name: /Same domain/ })).toBeDisabled();
  });

  it("shows the address and domain each mode will match on", async () => {
    open();
    expect(
      screen.getByRole("button", { name: "Same sender · billing@acme.test" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Same domain · @acme.test" })).toBeInTheDocument();
  });

  it("ignores a fetch that resolves after the mode already changed", async () => {
    // The stale response is the one that would silently repopulate the
    // list with the previous mode's matches.
    let resolveStale!: (v: unknown) => void;
    findSimilarEmails.mockReturnValueOnce(new Promise((r) => (resolveStale = r)));
    const { user } = open();

    findSimilarEmails.mockResolvedValue({ matches: [match("fresh")] });
    await user.click(screen.getByRole("button", { name: /Same domain/ }));
    await screen.findByText("1 of 1 selected");

    resolveStale({ matches: [match("s1"), match("s2"), match("s3")] });
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText("1 of 1 selected")).toBeInTheDocument();
  });
});

describe("selection", () => {
  it("pre-selects everything found and says so on the button", async () => {
    open();
    await screen.findByText("2 of 2 selected");
    expect(screen.getByRole("button", { name: "Move 2 to Receipts" })).toBeEnabled();
  });

  it("unchecking one keeps it out of the move", async () => {
    const { user } = open();
    await screen.findByText("2 of 2 selected");

    const row = screen.getByText("Subject e1").closest("label")!;
    await user.click(within(row).getByRole("checkbox"));

    expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();
    await user.click(moveButton());
    await waitFor(() => expect(bulkMoveEmails).toHaveBeenCalled());
    expect(moveData().email_ids).toEqual(["e2"]);
  });

  it("select-all clears when everything is already selected", async () => {
    const { user } = open();
    const header = (await screen.findByText("2 of 2 selected")).closest("label")!;

    await user.click(within(header).getByRole("checkbox"));
    expect(screen.getByText("0 of 2 selected")).toBeInTheDocument();
    expect(moveButton()).toBeDisabled();

    await user.click(within(header).getByRole("checkbox"));
    expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();
  });

  it("falls back through name, address and a placeholder for an unnamed sender", async () => {
    findSimilarEmails.mockResolvedValue({
      matches: [
        match("e1", { from_name: null }),
        match("e2", { from_name: null, from_addr: null }),
        match("e3", { subject: null, snippet: null, received_at: null }),
      ],
    });
    open();
    await screen.findByText("3 of 3 selected");

    expect(screen.getByText("billing@acme.test")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText("(no subject)")).toBeInTheDocument();
  });
});

describe("confirming the move", () => {
  it("moves the selection and saves a sender rule alongside it", async () => {
    const { user } = open();
    await screen.findByText("2 of 2 selected");
    await user.click(moveButton());

    await waitFor(() => expect(bulkMoveEmails).toHaveBeenCalled());
    expect(moveData()).toEqual({
      email_ids: ["e1", "e2"],
      to_folder_id: "f2",
      create_rule: { field: "from", value: "billing@acme.test" },
    });
    expect(toast.success).toHaveBeenCalledWith("Moved 2 to Receipts · rule saved");
  });

  it("saves a domain rule in domain mode", async () => {
    const { user } = open({ defaultMode: "domain" });
    await screen.findByText("2 of 2 selected");
    await user.click(moveButton());

    await waitFor(() => expect(bulkMoveEmails).toHaveBeenCalled());
    expect(moveData().create_rule).toEqual({ field: "domain", value: "acme.test" });
  });

  it("saves no rule when the email carries no address to build one from", async () => {
    // A `from` rule on a null sender matches nothing; omitting it is
    // honest, and the toast then does not claim a rule was saved.
    const { user } = open({ fromAddr: null });
    await screen.findByText("2 of 2 selected");
    await user.click(moveButton());

    await waitFor(() => expect(bulkMoveEmails).toHaveBeenCalled());
    expect(moveData().create_rule).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Moved 2 to Receipts");
  });

  it("reports partial failure in the same toast", async () => {
    bulkMoveEmails.mockResolvedValue({ moved: 1, failed: 1 });
    const { user } = open();
    await screen.findByText("2 of 2 selected");
    await user.click(moveButton());

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Moved 1 to Receipts · 1 failed · rule saved"),
    );
  });

  it("invalidates the mail and rule caches, then closes", async () => {
    const { user } = open();
    await screen.findByText("2 of 2 selected");
    await user.click(moveButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const keys = invalidateQueries.mock.calls.map(
      (c) => (c[0] as { queryKey: string[] }).queryKey[0],
    );
    expect(keys).toEqual(expect.arrayContaining(["emails", "emails-summary", "folder-filters"]));
  });

  it("keeps the dialog and the selection when the move fails", async () => {
    bulkMoveEmails.mockRejectedValue(new Error("Gmail rate limit"));
    const { user } = open();
    await screen.findByText("2 of 2 selected");
    await user.click(moveButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Gmail rate limit"));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();
  });

  it("falls back to a generic message for a non-Error rejection", async () => {
    bulkMoveEmails.mockRejectedValue("boom");
    const { user } = open();
    await screen.findByText("2 of 2 selected");
    await user.click(moveButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Something went wrong"));
  });

  it("closes without moving anything on Not now", async () => {
    const { user } = open();
    await screen.findByText("2 of 2 selected");
    await user.click(screen.getByRole("button", { name: "Not now" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(bulkMoveEmails).not.toHaveBeenCalled();
  });
});
