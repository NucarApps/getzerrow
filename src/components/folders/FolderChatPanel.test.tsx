// FolderChatPanel — the AI proposes changes to a folder; the user
// approves them one by one.
//
// An AI writing to a user's mail rules is exactly the place where "it
// looked like it worked" is not good enough, so the contracts pinned here
// are the ones that keep the human in the loop:
//
//   * NOTHING is written by proposing. Only the explicit Apply writes,
//     and only the actions still ticked when it was pressed,
//   * an applied or discarded turn is resolved for good — its checkboxes
//     are frozen and it cannot be applied twice, including after a
//     reload, because a re-offered action is one the user already
//     answered,
//   * a discard is persisted even though the UI updates optimistically;
//     otherwise the rejected proposal comes back on the next visit,
//   * partial failure is reported as partial, not as success — the
//     server applies each action independently,
//   * the applied settings are lifted back into the editor so the form
//     the user is looking at does not go stale against the row.
//
// The action wording and the settings patch are pure and covered in
// src/lib/ui/folder-chat-actions.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithQuery, mockReactStart, makeToastSpies } from "@/lib/__fixtures__/ui";

vi.mock("@tanstack/react-start", () => mockReactStart());

const { toast, module: sonnerModule } = makeToastSpies();
vi.mock("sonner", () => sonnerModule());

const proposeFolderChanges = vi.fn();
const applyFolderChanges = vi.fn();
const getFolderChatHistory = vi.fn();
const discardFolderChanges = vi.fn();
vi.mock("@/lib/folder-chat.functions", () => ({
  proposeFolderChanges: (...a: unknown[]) => proposeFolderChanges(...a),
  applyFolderChanges: (...a: unknown[]) => applyFolderChanges(...a),
  getFolderChatHistory: (...a: unknown[]) => getFolderChatHistory(...a),
  discardFolderChanges: (...a: unknown[]) => discardFolderChanges(...a),
}));

const invalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => ({ invalidateQueries }) };
});

const { FolderChatPanel } = await import("./FolderChatPanel");

const onApplied = vi.fn();
const FOLDER = { id: "f1", name: "Receipts" } as Parameters<typeof FolderChatPanel>[0]["folder"];

const archiveAction = {
  type: "update_folder_settings",
  settings: { auto_archive: true },
  why: "Keeps the inbox clear",
};
const renameAction = {
  type: "update_folder_settings",
  settings: { name: "Invoices" },
  why: null,
};

function render() {
  return renderWithQuery(<FolderChatPanel folder={FOLDER} onApplied={onApplied} />);
}

const input = () =>
  screen.getByPlaceholderText("Tell the assistant what to change in this folder…");
/** The proposed-changes card. `closest("div")` lands on the heading's own
 * wrapper, so climb to the card that actually holds the checkboxes. */
const proposalCard = () =>
  within(screen.getByText("Proposed changes").closest<HTMLElement>("div.rounded-lg")!);
const applyButton = () => screen.getByRole("button", { name: /Apply selected/ });

/** Send a message and get a proposal back. */
async function propose(
  user: ReturnType<typeof renderWithQuery>["user"],
  actions: unknown[] = [archiveAction],
  over: Record<string, unknown> = {},
) {
  const proposal = {
    reply: "Here's what I'd change.",
    clarifying_question: "",
    actions,
    message_id: "m1" as string | null,
    ...over,
  };
  proposeFolderChanges.mockResolvedValue(proposal);
  await user.type(input(), "auto-archive everything");
  await user.click(screen.getByRole("button", { name: "" }));
  // Wait on whichever half of the reply this proposal actually carries.
  await screen.findByText(proposal.reply || proposal.clarifying_question);
}

beforeEach(() => {
  getFolderChatHistory.mockResolvedValue({ messages: [] });
  applyFolderChanges.mockResolvedValue({ results: [{ ok: true }] });
  discardFolderChanges.mockResolvedValue(undefined);
});

describe("opening the panel", () => {
  it("loads this folder's conversation", async () => {
    render();
    await waitFor(() => expect(getFolderChatHistory).toHaveBeenCalled());
    expect(getFolderChatHistory).toHaveBeenCalledWith({ data: { folder_id: "f1" } });
  });

  it("suggests what to ask for when there is no history", async () => {
    render();
    expect(await screen.findByText(/nothing is\s+saved until you approve/)).toBeInTheDocument();
  });

  it("falls back to an empty conversation when the history cannot be read", async () => {
    getFolderChatHistory.mockRejectedValue(new Error("offline"));
    render();
    expect(await screen.findByText(/nothing is\s+saved until you approve/)).toBeInTheDocument();
  });

  it("restores an unresolved proposal as still actionable", async () => {
    getFolderChatHistory.mockResolvedValue({
      messages: [
        {
          id: "m0",
          role: "user",
          content: "archive it",
          actions: null,
          applied_action_indexes: [],
          discarded: false,
        },
        {
          id: "m1",
          role: "assistant",
          content: "Sure.",
          actions: [archiveAction],
          applied_action_indexes: [],
          discarded: false,
        },
      ],
    });
    render();

    expect(await screen.findByText("archive it")).toBeInTheDocument();
    expect(applyButton()).toBeEnabled();
  });

  it("restores a discarded turn as resolved, never re-offering it", async () => {
    // The user already answered this one; re-offering it is asking twice.
    getFolderChatHistory.mockResolvedValue({
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "Sure.",
          actions: [archiveAction],
          applied_action_indexes: [],
          discarded: true,
        },
      ],
    });
    render();

    expect(await screen.findByText("Dismissed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Apply selected/ })).not.toBeInTheDocument();
  });

  it("restores a partly-applied turn as applied, with the applied action unticked", async () => {
    getFolderChatHistory.mockResolvedValue({
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "Sure.",
          actions: [archiveAction, renameAction],
          applied_action_indexes: [0],
          discarded: false,
        },
      ],
    });
    render();

    expect(await screen.findByText("Applied")).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes[0]).not.toBeChecked();
    expect(boxes[1]).toBeChecked();
    // Resolved turns are frozen so nothing can be re-applied.
    expect(boxes[0]).toBeDisabled();
  });
});

describe("proposing", () => {
  it("sends the trimmed message for this folder and shows the reply", async () => {
    const { user } = render();
    await screen.findByText(/nothing is\s+saved until you approve/);
    await propose(user);

    expect(proposeFolderChanges).toHaveBeenCalledWith({
      data: { folder_id: "f1", user_message: "auto-archive everything" },
    });
    expect(screen.getByText("auto-archive everything")).toBeInTheDocument();
  });

  it("writes nothing at all by proposing", async () => {
    // The whole design is that the AI proposes and the human disposes.
    const { user } = render();
    await screen.findByText(/nothing is\s+saved until you approve/);
    await propose(user);

    expect(applyFolderChanges).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("ticks every proposed action by default", async () => {
    const { user } = render();
    await screen.findByText(/nothing is\s+saved until you approve/);
    await propose(user, [archiveAction, renameAction]);

    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeChecked();
  });

  it("shows the AI's reason for a change when it gave one", async () => {
    const { user } = render();
    await screen.findByText(/nothing is\s+saved until you approve/);
    await propose(user, [archiveAction]);
    expect(screen.getByText("Keeps the inbox clear")).toBeInTheDocument();
  });

  it("shows a clarifying question with no proposal to approve", async () => {
    const { user } = render();
    await screen.findByText(/nothing is\s+saved until you approve/);
    await propose(user, [], { reply: "", clarifying_question: "Which senders do you mean?" });

    expect(screen.getByText("Which senders do you mean?")).toBeInTheDocument();
    expect(screen.queryByText("Proposed changes")).not.toBeInTheDocument();
  });

  it("reports a failed proposal in the conversation as well as a toast", async () => {
    proposeFolderChanges.mockRejectedValue(new Error("AI is over quota"));
    const { user } = render();
    await screen.findByText(/nothing is\s+saved until you approve/);
    await user.type(input(), "do something");
    await user.click(screen.getByRole("button", { name: "" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("AI is over quota"));
    expect(screen.getByText("AI is over quota")).toBeInTheDocument();
  });

  it("falls back to a generic message for a non-Error rejection", async () => {
    proposeFolderChanges.mockRejectedValue("boom");
    const { user } = render();
    await screen.findByText(/nothing is\s+saved until you approve/);
    await user.type(input(), "do something");
    await user.click(screen.getByRole("button", { name: "" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't reach the AI"));
  });

  it("will not send an empty or whitespace-only message", async () => {
    const { user } = render();
    await screen.findByText(/nothing is\s+saved until you approve/);
    expect(screen.getByRole("button", { name: "" })).toBeDisabled();

    await user.type(input(), "   ");
    expect(screen.getByRole("button", { name: "" })).toBeDisabled();
    expect(proposeFolderChanges).not.toHaveBeenCalled();
  });

  it("sends on Enter but takes a newline on Shift+Enter", async () => {
    const { user } = render();
    await screen.findByText(/nothing is\s+saved until you approve/);
    proposeFolderChanges.mockResolvedValue({
      reply: "ok",
      clarifying_question: "",
      actions: [],
      message_id: null,
    });

    await user.type(input(), "line one{Shift>}{Enter}{/Shift}line two");
    expect(proposeFolderChanges).not.toHaveBeenCalled();

    await user.type(input(), "{Enter}");
    await waitFor(() => expect(proposeFolderChanges).toHaveBeenCalled());
  });

  it("clears the box so the sent message is not sent twice", async () => {
    const { user } = render();
    await screen.findByText(/nothing is\s+saved until you approve/);
    await propose(user);
    expect(input()).toHaveValue("");
  });
});

describe("applying", () => {
  const openProposal = async () => {
    const r = render();
    await screen.findByText(/nothing is\s+saved until you approve/);
    await propose(r.user, [archiveAction, renameAction]);
    return r;
  };

  it("applies only the actions still ticked", async () => {
    const { user } = await openProposal();
    await user.click(proposalCard().getAllByRole("checkbox")[1]!);
    await user.click(applyButton());

    await waitFor(() => expect(applyFolderChanges).toHaveBeenCalled());
    expect((applyFolderChanges.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      folder_id: "f1",
      actions: [archiveAction],
      message_id: "m1",
      applied_indexes: [0],
    });
  });

  it("refuses to apply with nothing ticked, rather than applying everything", async () => {
    const { user } = await openProposal();
    for (const box of proposalCard().getAllByRole("checkbox")) await user.click(box);
    await user.click(applyButton());

    expect(toast.message).toHaveBeenCalledWith("Nothing selected to apply.");
    expect(applyFolderChanges).not.toHaveBeenCalled();
  });

  it("reports how many changes landed", async () => {
    applyFolderChanges.mockResolvedValue({ results: [{ ok: true }, { ok: true }] });
    const { user } = await openProposal();
    await user.click(applyButton());

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Applied 2 changes"));
  });

  it("uses the singular for one change", async () => {
    applyFolderChanges.mockResolvedValue({ results: [{ ok: true }] });
    const { user } = await openProposal();
    await user.click(proposalCard().getAllByRole("checkbox")[1]!);
    await user.click(applyButton());

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Applied 1 change"));
  });

  it("reports partial failure as partial, not as success", async () => {
    // The server applies each action independently, so "2 applied" for a
    // run where one failed would be a lie about the folder's state.
    applyFolderChanges.mockResolvedValue({
      results: [{ ok: true }, { ok: false, error: "invalid forward address" }],
    });
    const { user } = await openProposal();
    await user.click(applyButton());

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Applied 1 change"));
    expect(toast.error).toHaveBeenCalledWith("1 change failed");
  });

  it("says nothing succeeded when nothing did", async () => {
    applyFolderChanges.mockResolvedValue({ results: [{ ok: false }, { ok: false }] });
    const { user } = await openProposal();
    await user.click(applyButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("2 changes failed"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("lifts the applied settings back into the editor", async () => {
    // Otherwise the form the user is looking at goes stale against the row.
    const { user } = await openProposal();
    await user.click(proposalCard().getAllByRole("checkbox")[1]!);
    await user.click(applyButton());

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith({ auto_archive: true }));
  });

  it("refreshes the folder and filter caches", async () => {
    const { user } = await openProposal();
    await user.click(applyButton());

    await waitFor(() => expect(invalidateQueries).toHaveBeenCalled());
    const keys = invalidateQueries.mock.calls.map(
      (c) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keys).toContainEqual(["folders"]);
    expect(keys).toContainEqual(["folders-full"]);
    expect(keys).toContainEqual(["folder-filters", "f1"]);
  });

  it("resolves the turn so the same changes cannot be applied twice", async () => {
    const { user } = await openProposal();
    await user.click(applyButton());

    await waitFor(() => expect(screen.getByText("Applied")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Apply selected/ })).not.toBeInTheDocument();
    for (const box of proposalCard().getAllByRole("checkbox")) expect(box).toBeDisabled();
  });

  it("leaves the turn actionable when the apply itself failed", async () => {
    applyFolderChanges.mockRejectedValue(new Error("folder is locked"));
    const { user } = await openProposal();
    await user.click(applyButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("folder is locked"));
    // Nothing landed, so the user must still be able to retry.
    expect(applyButton()).toBeEnabled();
    expect(onApplied).not.toHaveBeenCalled();
  });
});

describe("discarding", () => {
  const openProposal = async () => {
    const r = render();
    await screen.findByText(/nothing is\s+saved until you approve/);
    await propose(r.user, [archiveAction]);
    return r;
  };

  it("resolves the turn and writes nothing to the folder", async () => {
    const { user } = await openProposal();
    await user.click(screen.getByRole("button", { name: /Discard/ }));

    expect(await screen.findByText("Dismissed")).toBeInTheDocument();
    expect(applyFolderChanges).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("persists the rejection so it does not reappear after a reload", async () => {
    const { user } = await openProposal();
    await user.click(screen.getByRole("button", { name: /Discard/ }));

    await waitFor(() => expect(discardFolderChanges).toHaveBeenCalled());
    expect((discardFolderChanges.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      folder_id: "f1",
      message_id: "m1",
    });
  });

  it("keeps the turn dismissed but reports a failed persist", async () => {
    // The UI already moved on; saying nothing would hide that this one
    // WILL come back next time.
    discardFolderChanges.mockRejectedValue(new Error("write failed"));
    const { user } = await openProposal();
    await user.click(screen.getByRole("button", { name: /Discard/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("write failed"));
    expect(screen.getByText("Dismissed")).toBeInTheDocument();
  });

  it("does not call the server for a turn that was never persisted", async () => {
    const r = render();
    await screen.findByText(/nothing is\s+saved until you approve/);
    await propose(r.user, [archiveAction], { message_id: null });

    await r.user.click(screen.getByRole("button", { name: /Discard/ }));

    expect(await screen.findByText("Dismissed")).toBeInTheDocument();
    expect(discardFolderChanges).not.toHaveBeenCalled();
  });
});
