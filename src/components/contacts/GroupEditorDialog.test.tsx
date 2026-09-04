// GroupEditorDialog — create/edit/delete a contact label, its place in the
// group tree, and its folder link.
//
// The tree maths (eligibleParents, buildGroupTree) is pure and covered in
// src/lib/contacts/group-tree.test.ts. What this file pins is the wiring
// around it, plus the three destructive paths:
//
//   * the parent picker offers only parents the SERVER would accept —
//     rendering an ineligible one lets the user pick a save that fails, or
//     worse, a cycle,
//   * the folder link is only rewritten when it actually changed, since
//     linking creates and unlinking deletes a sender_in_group filter row,
//   * create-then-link is ordered: a new group has no id until it comes
//     back, so a link before that would target null,
//   * delete and prune are both behind a confirm that says what survives
//     — contacts keep existing, subgroups move up — and neither fires
//     from the dialog's own footer button,
//   * the auto-subgroup switch writes immediately (it is not part of
//     Save), and rolls back its own displayed state if that write fails.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithQuery, mockReactStart, makeToastSpies } from "@/lib/__fixtures__/ui";

vi.mock("@tanstack/react-start", () => mockReactStart());

const { toast, module: sonnerModule } = makeToastSpies();
vi.mock("sonner", () => sonnerModule());

const createContactGroup = vi.fn();
const updateContactGroup = vi.fn();
const deleteContactGroup = vi.fn();
const linkContactGroupToFolder = vi.fn();
vi.mock("@/lib/contact-groups.functions", () => ({
  createContactGroup: (...a: unknown[]) => createContactGroup(...a),
  updateContactGroup: (...a: unknown[]) => updateContactGroup(...a),
  deleteContactGroup: (...a: unknown[]) => deleteContactGroup(...a),
  linkContactGroupToFolder: (...a: unknown[]) => linkContactGroupToFolder(...a),
}));

const listFoldersForPicker = vi.fn();
vi.mock("@/lib/contacts.functions", () => ({
  listFoldersForPicker: (...a: unknown[]) => listFoldersForPicker(...a),
}));

const setAutoCompanySubgroups = vi.fn();
const reconcileAutoCompanySubgroups = vi.fn();
const pruneAutoCompanySubgroups = vi.fn();
vi.mock("@/lib/contacts/auto-company-subgroups.functions", () => ({
  setAutoCompanySubgroups: (...a: unknown[]) => setAutoCompanySubgroups(...a),
  reconcileAutoCompanySubgroups: (...a: unknown[]) => reconcileAutoCompanySubgroups(...a),
  pruneAutoCompanySubgroups: (...a: unknown[]) => pruneAutoCompanySubgroups(...a),
}));

// The rules section is its own component with its own queries; it is not
// what this dialog's contracts are about.
vi.mock("@/components/contacts/GroupRulesSection", () => ({
  GroupRulesSection: ({ groupId }: { groupId: string }) => (
    <div data-testid="group-rules">{groupId}</div>
  ),
}));

import type { GroupRow, GroupEditorState } from "./GroupEditorDialog";

const { GroupEditorDialog } = await import("./GroupEditorDialog");

const onClose = vi.fn();
const onChanged = vi.fn();

const group = (over: Partial<GroupRow> & { id: string; name: string }): GroupRow => ({
  color: "#6366f1",
  count: 0,
  ...over,
});

const WORK = group({ id: "g1", name: "Work" });
const NESTED = group({ id: "g2", name: "Nested", parent_group_id: "g1" });
const ALL = [WORK, NESTED];

function open(state: GroupEditorState, allGroups: GroupRow[] = ALL) {
  return renderWithQuery(
    <GroupEditorDialog
      state={state}
      allGroups={allGroups}
      onClose={onClose}
      onChanged={onChanged}
    />,
  );
}

const nameBox = () => screen.getByPlaceholderText("Work, Personal, Investors…");
const saveButton = () => screen.getByRole("button", { name: "Save" });
/** Open one of the two Selects by its caption and pick an option. Both
 * triggers are named by their caption via aria-labelledby — a Radix
 * trigger takes no htmlFor, so without that they have no accessible name
 * at all and neither a screen reader nor this test can tell them apart. */
async function selectOption(
  user: ReturnType<typeof renderWithQuery>["user"],
  select: "Parent group" | "Linked folder",
  option: string | RegExp,
) {
  await user.click(screen.getByRole("combobox", { name: select }));
  await user.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  listFoldersForPicker.mockResolvedValue({
    folders: [
      { id: "f1", name: "Newsletters" },
      { id: "f2", name: "Receipts" },
    ],
  });
  createContactGroup.mockResolvedValue({ group: { id: "new-group" } });
  updateContactGroup.mockResolvedValue(undefined);
  deleteContactGroup.mockResolvedValue(undefined);
  linkContactGroupToFolder.mockResolvedValue(undefined);
  setAutoCompanySubgroups.mockResolvedValue(undefined);
  reconcileAutoCompanySubgroups.mockResolvedValue({ stats: { created: 0, removed: 0 } });
  pruneAutoCompanySubgroups.mockResolvedValue({ removed: 0 });
});

describe("closed state", () => {
  it("renders nothing and fetches nothing without a state", () => {
    const { container } = open(null);
    expect(container).toBeEmptyDOMElement();
    expect(listFoldersForPicker).not.toHaveBeenCalled();
  });
});

describe("creating a group", () => {
  it("opens empty, titled New group", () => {
    open({ mode: "create" });
    expect(screen.getByText("New group")).toBeInTheDocument();
    expect(nameBox()).toHaveValue("");
  });

  it("refuses to save an empty or whitespace-only name", async () => {
    const { user } = open({ mode: "create" });
    expect(saveButton()).toBeDisabled();

    await user.type(nameBox(), "   ");
    expect(saveButton()).toBeDisabled();
    expect(createContactGroup).not.toHaveBeenCalled();
  });

  it("trims the name and sends the default colour", async () => {
    const { user } = open({ mode: "create" });
    await user.type(nameBox(), "  Investors  ");
    await user.click(saveButton());

    await waitFor(() => expect(createContactGroup).toHaveBeenCalled());
    expect((createContactGroup.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      name: "Investors",
      color: "#6366f1",
      parent_group_id: null,
    });
    expect(toast.success).toHaveBeenCalledWith("Group created");
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("nests under the parent the caller pre-selected", async () => {
    const { user } = open({ mode: "create", parentId: "g1" });
    await user.type(nameBox(), "Investors");
    await user.click(saveButton());

    await waitFor(() => expect(createContactGroup).toHaveBeenCalled());
    expect(
      (createContactGroup.mock.calls[0]![0] as { data: { parent_group_id: string } }).data
        .parent_group_id,
    ).toBe("g1");
  });

  it("sends the colour the user picked", async () => {
    const { user } = open({ mode: "create" });
    await user.type(nameBox(), "Investors");
    const swatches = screen.getAllByRole("button", { name: /^#[0-9a-f]{6}$/i });
    await user.click(swatches[2]!);
    await user.click(saveButton());

    await waitFor(() => expect(createContactGroup).toHaveBeenCalled());
    const sent = (createContactGroup.mock.calls[0]![0] as { data: { color: string } }).data.color;
    expect(sent).toBe(swatches[2]!.getAttribute("aria-label"));
  });

  it("links the new group's folder only after it has an id", async () => {
    const { user } = open({ mode: "create" });
    await user.type(nameBox(), "Investors");
    await selectOption(user, "Linked folder", "Receipts");
    await user.click(saveButton());

    await waitFor(() => expect(linkContactGroupToFolder).toHaveBeenCalled());
    // Linking before the create resolves would target a null group id.
    expect(createContactGroup.mock.invocationCallOrder[0]!).toBeLessThan(
      linkContactGroupToFolder.mock.invocationCallOrder[0]!,
    );
    expect((linkContactGroupToFolder.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      groupId: "new-group",
      folderId: "f2",
    });
  });

  it("does not link a folder that was never chosen", async () => {
    const { user } = open({ mode: "create" });
    await user.type(nameBox(), "Investors");
    await user.click(saveButton());

    await waitFor(() => expect(createContactGroup).toHaveBeenCalled());
    expect(linkContactGroupToFolder).not.toHaveBeenCalled();
  });

  it("offers no auto-subgroup controls or rules until the group exists", () => {
    open({ mode: "create" });
    expect(screen.queryByText("Auto-create company subgroups")).not.toBeInTheDocument();
    expect(screen.queryByTestId("group-rules")).not.toBeInTheDocument();
  });

  it("reports a failed create and keeps the dialog open", async () => {
    createContactGroup.mockRejectedValue(new Error("A group with that name exists"));
    const { user } = open({ mode: "create" });
    await user.type(nameBox(), "Work");
    await user.click(saveButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("A group with that name exists"));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("editing a group", () => {
  const editing = {
    mode: "edit" as const,
    group: group({ id: "g3", name: "Clients", color: "#111", folder_id: "f1" }),
  };

  it("seeds every field from the group", async () => {
    open(editing, [...ALL, editing.group]);
    expect(screen.getByText("Edit group")).toBeInTheDocument();
    expect(nameBox()).toHaveValue("Clients");
    // The trigger can only name the folder once the picker query resolves.
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Linked folder" })).toHaveTextContent(
        "Newsletters",
      ),
    );
  });

  it("sends the id with the update", async () => {
    const { user } = open(editing, [...ALL, editing.group]);
    await user.clear(nameBox());
    await user.type(nameBox(), "Customers");
    await user.click(saveButton());

    await waitFor(() => expect(updateContactGroup).toHaveBeenCalled());
    expect((updateContactGroup.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      id: "g3",
      name: "Customers",
      color: "#111",
      parent_group_id: null,
    });
    expect(toast.success).toHaveBeenCalledWith("Group updated");
  });

  it("leaves an unchanged folder link alone", async () => {
    // Re-linking would delete and recreate the sender_in_group filter row
    // for no reason.
    const { user } = open(editing, [...ALL, editing.group]);
    await user.click(saveButton());

    await waitFor(() => expect(updateContactGroup).toHaveBeenCalled());
    expect(linkContactGroupToFolder).not.toHaveBeenCalled();
  });

  it("rewrites the link when the folder changes", async () => {
    const { user } = open(editing, [...ALL, editing.group]);
    await selectOption(user, "Linked folder", "Receipts");
    await user.click(saveButton());

    await waitFor(() => expect(linkContactGroupToFolder).toHaveBeenCalled());
    expect((linkContactGroupToFolder.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      groupId: "g3",
      folderId: "f2",
    });
  });

  it("unlinks by sending a null folder", async () => {
    const { user } = open(editing, [...ALL, editing.group]);
    await selectOption(user, "Linked folder", "None — group only");
    await user.click(saveButton());

    await waitFor(() => expect(linkContactGroupToFolder).toHaveBeenCalled());
    expect(
      (linkContactGroupToFolder.mock.calls[0]![0] as { data: { folderId: null } }).data.folderId,
    ).toBeNull();
  });

  it("never offers the group itself as its own parent", async () => {
    const { user } = open(editing, [...ALL, editing.group]);
    await user.click(screen.getByRole("combobox", { name: "Parent group" }));

    // Picking itself would be a cycle; the server rejects it, so it must
    // not be offered.
    expect(screen.queryByRole("option", { name: "Clients" })).not.toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /Work/ })).toBeInTheDocument();
  });

  it("passes the group through to the rules section", () => {
    open(editing, [...ALL, editing.group]);
    expect(screen.getByTestId("group-rules")).toHaveTextContent("g3");
  });
});

describe("deleting a group", () => {
  const editing = { mode: "edit" as const, group: group({ id: "g3", name: "Clients" }) };

  it("asks first, and the footer button alone deletes nothing", async () => {
    const { user } = open(editing);
    await user.click(screen.getByRole("button", { name: /Delete/ }));

    expect(await screen.findByText("Delete “Clients”?")).toBeInTheDocument();
    expect(deleteContactGroup).not.toHaveBeenCalled();
  });

  it("says what survives the delete", async () => {
    const { user } = open(editing);
    await user.click(screen.getByRole("button", { name: /Delete/ }));

    expect(
      await screen.findByText(/Contacts won't be deleted.*Subgroups move to the top level/s),
    ).toBeInTheDocument();
  });

  it("deletes on confirm and closes", async () => {
    const { user } = open(editing);
    await user.click(screen.getByRole("button", { name: /Delete/ }));
    await user.click(await screen.findByRole("button", { name: "Delete group" }));

    await waitFor(() => expect(deleteContactGroup).toHaveBeenCalled());
    expect((deleteContactGroup.mock.calls[0]![0] as { data: unknown }).data).toEqual({ id: "g3" });
    expect(toast.success).toHaveBeenCalledWith("Group deleted");
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("deletes nothing when the confirm is cancelled", async () => {
    const { user } = open(editing);
    await user.click(screen.getByRole("button", { name: /Delete/ }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(deleteContactGroup).not.toHaveBeenCalled();
  });

  it("reports a failed delete without closing", async () => {
    deleteContactGroup.mockRejectedValue(new Error("Group has members"));
    const { user } = open(editing);
    await user.click(screen.getByRole("button", { name: /Delete/ }));
    await user.click(await screen.findByRole("button", { name: "Delete group" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Group has members"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers no delete for a group being created", () => {
    open({ mode: "create" });
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
  });
});

describe("auto company subgroups", () => {
  const off = { mode: "edit" as const, group: group({ id: "g3", name: "Clients" }) };
  const on = {
    mode: "edit" as const,
    group: group({ id: "g3", name: "Clients", auto_company_subgroups: true }),
  };

  it("writes the switch immediately rather than waiting for Save", async () => {
    const { user } = open(off);
    await user.click(screen.getByRole("switch"));

    await waitFor(() => expect(setAutoCompanySubgroups).toHaveBeenCalled());
    expect((setAutoCompanySubgroups.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      groupId: "g3",
      enabled: true,
    });
    expect(toast.success).toHaveBeenCalledWith("Auto subgroups enabled");
    expect(updateContactGroup).not.toHaveBeenCalled();
  });

  it("says paused rather than enabled when switching off", async () => {
    const { user } = open(on);
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Auto subgroups paused"));
  });

  it("leaves the switch where it was when the write fails", async () => {
    // Showing "on" for a setting the server rejected would make the
    // Re-scan button available for a feature that is not enabled.
    setAutoCompanySubgroups.mockRejectedValue(new Error("nope"));
    const { user } = open(off);
    await user.click(screen.getByRole("switch"));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nope"));
    expect(screen.getByRole("switch")).not.toBeChecked();
  });

  it("cannot re-scan while the feature is off", () => {
    open(off);
    expect(screen.getByRole("button", { name: "Re-scan now" })).toBeDisabled();
  });

  it("reports what a re-scan created and removed", async () => {
    reconcileAutoCompanySubgroups.mockResolvedValue({ stats: { created: 3, removed: 1 } });
    const { user } = open(on);
    await user.click(screen.getByRole("button", { name: "Re-scan now" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Re-scanned: +3 / -1 subgroups"),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("reads a re-scan with no stats as zero rather than undefined", async () => {
    reconcileAutoCompanySubgroups.mockResolvedValue({});
    const { user } = open(on);
    await user.click(screen.getByRole("button", { name: "Re-scan now" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Re-scanned: +0 / -0 subgroups"),
    );
  });

  it("asks before pruning, naming the group twice over", async () => {
    const { user } = open(on);
    await user.click(screen.getByRole("button", { name: "Remove auto subgroups" }));

    expect(await screen.findByText("Remove all auto-created subgroups?")).toBeInTheDocument();
    expect(screen.getByText(/Contacts stay in “Clients”/)).toBeInTheDocument();
    expect(pruneAutoCompanySubgroups).not.toHaveBeenCalled();
  });

  it("prunes on confirm and counts what went", async () => {
    pruneAutoCompanySubgroups.mockResolvedValue({ removed: 4 });
    const { user } = open(on);
    await user.click(screen.getByRole("button", { name: "Remove auto subgroups" }));
    await user.click(await screen.findByRole("button", { name: "Remove subgroups" }));

    await waitFor(() => expect(pruneAutoCompanySubgroups).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("Removed 4 auto subgroups");
  });

  it("uses the singular for one subgroup", async () => {
    pruneAutoCompanySubgroups.mockResolvedValue({ removed: 1 });
    const { user } = open(on);
    await user.click(screen.getByRole("button", { name: "Remove auto subgroups" }));
    await user.click(await screen.findByRole("button", { name: "Remove subgroups" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Removed 1 auto subgroup"));
  });

  it("reports a failed prune", async () => {
    pruneAutoCompanySubgroups.mockRejectedValue(new Error("busy"));
    const { user } = open(on);
    await user.click(screen.getByRole("button", { name: "Remove auto subgroups" }));
    await user.click(await screen.findByRole("button", { name: "Remove subgroups" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("busy"));
  });
});

describe("cancelling", () => {
  it("closes without writing", async () => {
    const { user } = open({ mode: "create" });
    await user.type(nameBox(), "Investors");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalled();
    expect(createContactGroup).not.toHaveBeenCalled();
  });

  it("closes when the dialog is dismissed", async () => {
    const { user } = open({ mode: "create" });
    const dialog = within(screen.getByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
