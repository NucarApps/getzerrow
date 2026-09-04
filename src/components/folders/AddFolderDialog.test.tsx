// AddFolderDialog — create a folder, optionally mirror it to a Gmail
// label, and give it its starting intent.
//
// Three writes happen behind one button, and they are deliberately NOT
// all-or-nothing: the folder is the thing the user asked for, so the Gmail
// label and the settings patch each degrade to a warning rather than
// taking the folder down with them. That ordering is the contract:
//
//   * the Gmail label is created FIRST, because its id goes into the
//     folder row; a failure there means a folder with no mirror, warned
//     about, not a failed create,
//   * the folder create is the only fatal step — its failure stops
//     everything and never leaves a settings patch pointed at nothing,
//   * the settings patch is last and only sent when there is something in
//     it, so an untouched form does not write defaults over a fresh row,
//   * a description activates AI sorting (skip_ai=false) and is capped at
//     2000 characters, matching the folder editor,
//   * the success message states what will actually happen next, which
//     differs by whether AI was activated and whether a label exists.
//
// New folders are inert by design — no ingestion, no mirroring — unless
// the user gives them intent here, so "writes nothing extra" is a
// contract, not an omission.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithQuery, mockReactStart, makeToastSpies } from "@/lib/__fixtures__/ui";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", () => mockReactStart());

const { toast, module: sonnerModule } = makeToastSpies();
vi.mock("sonner", () => sonnerModule());

vi.mock("@/integrations/supabase/client", () => ({
  get supabase() {
    return fake.supabaseAdmin;
  },
}));

const createGmailLabel = vi.fn();
vi.mock("@/lib/gmail.functions", () => ({
  createGmailLabel: (...a: unknown[]) => createGmailLabel(...a),
}));

const createFolder = vi.fn();
vi.mock("@/lib/gmail/folder-mgmt.functions", () => ({
  createFolder: (...a: unknown[]) => createFolder(...a),
}));

const invalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => ({ invalidateQueries }) };
});

const { AddFolderDialog } = await import("./AddFolderDialog");

const onOpenChange = vi.fn();
const ACCOUNT = "acct-1";
const LABELS = [
  { id: "l1", name: "Atzro" },
  { id: "l2", name: "Atzro/Work" },
  { id: "l3", name: "Personal" },
] as Parameters<typeof AddFolderDialog>[0]["labels"];

function open(over: Partial<Parameters<typeof AddFolderDialog>[0]> = {}) {
  return renderWithQuery(
    <AddFolderDialog
      open
      onOpenChange={onOpenChange}
      accountId={ACCOUNT}
      labels={LABELS}
      {...over}
    />,
  );
}

const nameBox = () => screen.getByPlaceholderText("Folder name");
const descBox = () => screen.getByLabelText("What belongs here?");
const createButton = () => screen.getByRole("button", { name: "Create folder" });
const folderData = () => (createFolder.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
const patch = () => fake.calls.updates[0]?.payload as Record<string, unknown> | undefined;

async function fillAndCreate(
  user: ReturnType<typeof renderWithQuery>["user"],
  name = "Recruiting",
) {
  await user.type(nameBox(), name);
  await user.click(createButton());
}

beforeEach(() => {
  fake.reset();
  createGmailLabel.mockResolvedValue({ id: "gmail-label-1" });
  createFolder.mockResolvedValue({ id: "folder-1" });
});

describe("the create gate", () => {
  it("will not create without a name or an account", async () => {
    const { user, unmount } = open();
    expect(createButton()).toBeDisabled();
    await user.type(nameBox(), "   ");
    expect(createButton()).toBeDisabled();
    unmount();

    open({ accountId: null });
    expect(createButton()).toBeDisabled();
  });

  it("creates on Enter in the name field", async () => {
    const { user } = open();
    await user.type(nameBox(), "Recruiting{Enter}");
    await waitFor(() => expect(createFolder).toHaveBeenCalled());
  });

  it("trims the name for both the label and the folder", async () => {
    const { user } = open();
    await fillAndCreate(user, "  Recruiting  ");

    await waitFor(() => expect(createFolder).toHaveBeenCalled());
    expect((createGmailLabel.mock.calls[0]![0] as { data: { name: string } }).data.name).toBe(
      "Recruiting",
    );
    expect(folderData().name).toBe("Recruiting");
  });
});

describe("the Gmail label", () => {
  it("mirrors to a new label by default, and puts its id on the folder", async () => {
    const { user } = open();
    await fillAndCreate(user);

    await waitFor(() => expect(createFolder).toHaveBeenCalled());
    // The label has to exist before the folder row can point at it.
    expect(createGmailLabel.mock.invocationCallOrder[0]!).toBeLessThan(
      createFolder.mock.invocationCallOrder[0]!,
    );
    expect(folderData().gmail_label_id).toBe("gmail-label-1");
  });

  it("nests the new label under the chosen parent", async () => {
    const { user } = open();
    await user.click(screen.getByRole("combobox", { name: "Parent Gmail label" }));
    await user.click(await screen.findByRole("option", { name: "Under: Work" }));
    await fillAndCreate(user);

    await waitFor(() => expect(createGmailLabel).toHaveBeenCalled());
    expect((createGmailLabel.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      account_id: ACCOUNT,
      name: "Recruiting",
      parent_label_id: "l2",
    });
  });

  it("offers only Atzro labels as parents", async () => {
    const { user } = open();
    await user.click(screen.getByRole("combobox", { name: "Parent Gmail label" }));

    expect(await screen.findByRole("option", { name: "Under: Atzro (root)" })).toBeInTheDocument();
    // A parent outside the Atzro tree would put the mirror somewhere the
    // sync code does not look.
    expect(screen.queryByRole("option", { name: /Personal/ })).not.toBeInTheDocument();
  });

  it("sends no parent when none was picked", async () => {
    const { user } = open();
    await fillAndCreate(user);

    await waitFor(() => expect(createGmailLabel).toHaveBeenCalled());
    expect((createGmailLabel.mock.calls[0]![0] as { data: object }).data).not.toHaveProperty(
      "parent_label_id",
    );
  });

  it("links to an existing label instead of creating one", async () => {
    const { user } = open();
    await user.click(screen.getByRole("combobox", { name: "Gmail label" }));
    await user.click(await screen.findByRole("option", { name: "Link to: Personal" }));
    await fillAndCreate(user);

    await waitFor(() => expect(createFolder).toHaveBeenCalled());
    expect(createGmailLabel).not.toHaveBeenCalled();
    expect(folderData().gmail_label_id).toBe("l3");
  });

  it("creates an unmirrored folder when the user wants no label", async () => {
    const { user } = open();
    await user.click(screen.getByRole("combobox", { name: "Gmail label" }));
    await user.click(await screen.findByRole("option", { name: "No Gmail label" }));
    await fillAndCreate(user);

    await waitFor(() => expect(createFolder).toHaveBeenCalled());
    expect(createGmailLabel).not.toHaveBeenCalled();
    expect(folderData().gmail_label_id).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Folder created.");
  });

  it("still creates the folder when Gmail refuses the label", async () => {
    // The folder is what the user asked for; losing it because Gmail was
    // unreachable would be the wrong trade.
    createGmailLabel.mockRejectedValue(new Error("Gmail 403"));
    const { user } = open();
    await fillAndCreate(user);

    await waitFor(() => expect(createFolder).toHaveBeenCalled());
    expect(toast.warning).toHaveBeenCalledWith(
      "Couldn't create Gmail label. Folder created locally.",
    );
    expect(folderData().gmail_label_id).toBeNull();
  });

  it("hides the parent picker unless a new label is being made", async () => {
    const { user } = open();
    await user.click(screen.getByRole("combobox", { name: "Gmail label" }));
    await user.click(await screen.findByRole("option", { name: "No Gmail label" }));

    expect(screen.queryByRole("combobox", { name: "Parent Gmail label" })).not.toBeInTheDocument();
  });
});

describe("the folder row", () => {
  it("carries the account and the chosen colour", async () => {
    const { user } = open();
    const swatches = screen.getAllByRole("radio");
    await user.click(swatches[1]!);
    await fillAndCreate(user);

    await waitFor(() => expect(createFolder).toHaveBeenCalled());
    expect(folderData().account_id).toBe(ACCOUNT);
    expect(folderData().color).toBe(swatches[1]!.getAttribute("aria-label")?.replace("Color ", ""));
  });

  it("stops everything when the folder create fails", async () => {
    createFolder.mockRejectedValue(new Error("A folder with that name exists"));
    const { user } = open();
    await fillAndCreate(user);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("A folder with that name exists"));
    // A settings patch here would target a folder that does not exist.
    expect(fake.calls.updates).toEqual([]);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("falls back to a generic message for a non-Error rejection", async () => {
    createFolder.mockRejectedValue("boom");
    const { user } = open();
    await fillAndCreate(user);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to create folder"));
  });
});

describe("starting intent", () => {
  it("writes nothing extra for an untouched form", async () => {
    // New folders are inert by design; writing defaults would turn on
    // behaviour the user never asked for.
    const { user } = open();
    await fillAndCreate(user);

    await waitFor(() => expect(createFolder).toHaveBeenCalled());
    expect(fake.calls.updates).toEqual([]);
  });

  it("a description activates AI sorting", async () => {
    const { user } = open();
    await user.type(descBox(), "  Recruiter emails and offers  ");
    await fillAndCreate(user);

    await waitFor(() => expect(patch()).toBeTruthy());
    expect(patch()).toEqual({ ai_rule: "Recruiter emails and offers", skip_ai: false });
    expect(fake.calls.updates[0]?.filters).toEqual([
      { op: "eq", col: "id", value: "folder-1", extra: undefined },
    ]);
  });

  it("caps the description at 2000 characters", async () => {
    const { user } = open();
    // Typing 2001 characters through userEvent is slow; paste instead.
    await user.click(descBox());
    await user.paste("x".repeat(2500));
    await fillAndCreate(user);

    await waitFor(() => expect(patch()).toBeTruthy());
    expect((patch()!.ai_rule as string).length).toBe(2000);
  });

  it("sends each landing action only when it was turned on", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: /Skip inbox/ }));
    await user.click(screen.getByRole("button", { name: /Star/ }));
    await fillAndCreate(user);

    await waitFor(() => expect(patch()).toBeTruthy());
    expect(patch()).toEqual({ auto_archive: true, auto_star: true });
    expect(patch()).not.toHaveProperty("auto_mark_read");
  });

  it("warns without failing when the settings patch is rejected", async () => {
    // The folder exists at this point — reporting failure would be wrong.
    fake.onUpdate("folders", () => ({ message: "rls denied" }));
    const { user } = open();
    await user.type(descBox(), "Recruiter emails");
    await fillAndCreate(user);

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "Folder created, but its settings couldn't be saved. Edit the folder to retry.",
      ),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("finishing up", () => {
  it("says AI will sort when a description was given", async () => {
    const { user } = open();
    await user.type(descBox(), "Recruiter emails");
    await fillAndCreate(user);

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Folder created — AI will start sorting new mail. Use Re-learn to pull existing matches.",
      ),
    );
  });

  it("points at Re-learn when there is a label but no description", async () => {
    const { user } = open();
    await fillAndCreate(user);

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Folder created. Open it and click Re-learn to pull matching Gmail messages.",
      ),
    );
  });

  it("refreshes both folder caches and closes", async () => {
    const { user } = open();
    await fillAndCreate(user);

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const keys = invalidateQueries.mock.calls.map(
      (c) => (c[0] as { queryKey: string[] }).queryKey[0],
    );
    expect(keys).toEqual(expect.arrayContaining(["folders", "folders-full"]));
  });

  it("clears the form so the next open does not inherit it", async () => {
    const { user } = open();
    await user.type(descBox(), "Recruiter emails");
    await user.click(screen.getByRole("button", { name: /Skip inbox/ }));
    await fillAndCreate(user);

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(nameBox()).toHaveValue("");
    expect(descBox()).toHaveValue("");
    expect(screen.getByRole("button", { name: /Skip inbox/ })).toHaveAttribute(
      "class",
      expect.not.stringContaining("border-primary"),
    );
  });
});
