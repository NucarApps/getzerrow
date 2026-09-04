// FilterLikeThisDrawer — "filter messages like this" from an open email.
//
// This drawer WRITES rules that route mail for good, and optionally moves
// or archives past mail, so the contracts worth pinning are the ones where
// getting it wrong is either invisible or destructive:
//
//   * FORWARDED MAIL. When a message reached the user via a forwarder, a
//     rule built from the visible sender targets the forwarder — matching
//     everything that mailbox relays, not the sender the user meant. The
//     drawer defaults to the original sender and saves the `origin_*` rule
//     fields; when no header named the real sender it can only warn.
//   * INBOX MODE. "Inbox — always show" is a different server call with a
//     narrower contract: sender/domain only, exact match only, and never
//     origin matching. The drawer has to switch the user off a subject
//     rule rather than send one that will be rejected.
//   * MARK-READ. The control seeds to what the folder ALREADY does, and
//     the write only happens when the user actually moved it — otherwise
//     opening this drawer would silently reshape a folder's settings.
//   * PAST MAIL runs after the dialog closes, so its failure has to be
//     reported on its own and must not read as the rule having failed.
//   * The value shown is the one the rule engine will match on: a
//     divergent derivation here creates a rule that can never match the
//     mail it was created from.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithQuery, mockReactStart, makeToastSpies } from "@/lib/__fixtures__/ui";

vi.mock("@tanstack/react-start", () => mockReactStart());

const { toast, module: sonnerModule } = makeToastSpies();
vi.mock("sonner", () => sonnerModule());

const addFolderRule = vi.fn();
const countMatchingForRule = vi.fn();
const applyFilterRuleToPast = vi.fn();
const addInboxOverride = vi.fn();
const stripFolderLabelPast = vi.fn();
vi.mock("@/lib/gmail.functions", () => ({
  addFolderRule: (...a: unknown[]) => addFolderRule(...a),
  countMatchingForRule: (...a: unknown[]) => countMatchingForRule(...a),
  applyFilterRuleToPast: (...a: unknown[]) => applyFilterRuleToPast(...a),
  addInboxOverride: (...a: unknown[]) => addInboxOverride(...a),
  stripFolderLabelPast: (...a: unknown[]) => stripFolderLabelPast(...a),
}));

const getFolderMarkReadDecision = vi.fn();
const setSenderMarkRead = vi.fn();
vi.mock("@/lib/gmail/mark-read-rules.functions", () => ({
  getFolderMarkReadDecision: (...a: unknown[]) => getFolderMarkReadDecision(...a),
  setSenderMarkRead: (...a: unknown[]) => setSenderMarkRead(...a),
}));

const invalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => ({ invalidateQueries }) };
});

const { FilterLikeThisDrawer } = await import("./FilterLikeThisDrawer");

const onOpenChange = vi.fn();
const FOLDERS = [
  { id: "f1", name: "Newsletters", color: "#111" },
  { id: "f2", name: "Receipts", color: "#222" },
];

type Props = Parameters<typeof FilterLikeThisDrawer>[0];

function open(over: Partial<Props> = {}) {
  return renderWithQuery(
    <FilterLikeThisDrawer
      open
      onOpenChange={onOpenChange}
      accountId="acct-1"
      fromAddr="news@acme.test"
      subject="Weekly digest — issue 12"
      folders={FOLDERS}
      currentFolderId={null}
      {...over}
    />,
  );
}

const valueBox = () => screen.getByLabelText(/Sender address|Domain|Subject text/);
const saveButton = () => screen.getByRole("button", { name: /Create filter|Add to inbox list/ });
const ruleData = () => (addFolderRule.mock.calls[0]![0] as { data: Record<string, unknown> }).data;

beforeEach(() => {
  vi.useRealTimers();
  countMatchingForRule.mockResolvedValue({ count: 0 });
  addFolderRule.mockResolvedValue({ already: false });
  addInboxOverride.mockResolvedValue({ already: false });
  applyFilterRuleToPast.mockResolvedValue({ moved: 0, archived: 0, failed: 0 });
  stripFolderLabelPast.mockResolvedValue({ stripped_count: 0 });
  getFolderMarkReadDecision.mockResolvedValue({
    auto_mark_read: false,
    mark_read_mode: "all",
    listed: false,
    would_mark_read: false,
  });
  setSenderMarkRead.mockResolvedValue(undefined);
});

describe("seeding the rule from the email", () => {
  it("starts on the sender with the address filled in", () => {
    open();
    expect(screen.getByLabelText("Sender address")).toHaveValue("news@acme.test");
  });

  it("falls back to the subject when the mail has no sender address", () => {
    open({ fromAddr: null });
    expect(screen.getByLabelText("Subject text")).toHaveValue("Weekly digest — issue 12");
  });

  it("derives the domain the same way the rule engine will", async () => {
    // A divergent derivation here would create a rule that can never match
    // the mail it was built from.
    const { user } = open();
    await user.click(screen.getByRole("button", { name: /Domain/ }));
    expect(screen.getByLabelText("Domain")).toHaveValue("acme.test");
  });

  it("disables a match field the email cannot supply", () => {
    open({ subject: null });
    expect(screen.getByRole("button", { name: /Subject/ })).toBeDisabled();
  });

  it("switches subject rules to starts-with and sender rules to contains", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: /Subject/ }));
    expect(screen.getByRole("radio", { name: /Starts with/ })).toBeChecked();
  });
});

describe("live match count", () => {
  it("counts against the field and op that will actually be saved", async () => {
    open();
    await waitFor(() => expect(countMatchingForRule).toHaveBeenCalled());
    expect(countMatchingForRule.mock.calls[0]![0]).toEqual({
      data: { account_id: "acct-1", field: "from", op: "contains", value: "news@acme.test" },
    });
  });

  it("reports zero, one and the capped count in words", async () => {
    countMatchingForRule.mockResolvedValue({ count: 0 });
    const { user, unmount } = open();
    expect(await screen.findByText("No existing emails match.")).toBeInTheDocument();
    unmount();

    countMatchingForRule.mockResolvedValue({ count: 1 });
    open();
    expect(await screen.findByText("About 1 existing email match.")).toBeInTheDocument();
    void user;
  });

  it("says 500+ rather than an exact number at the cap", async () => {
    countMatchingForRule.mockResolvedValue({ count: 500 });
    open();
    expect(await screen.findByText("About 500+ existing emails match.")).toBeInTheDocument();
  });

  it("shows no count rather than a stale one when counting fails", async () => {
    countMatchingForRule.mockRejectedValue(new Error("timeout"));
    open();
    await waitFor(() => expect(countMatchingForRule).toHaveBeenCalled());
    expect(screen.queryByText(/existing email/)).not.toBeInTheDocument();
  });

  it("does not count without an account", async () => {
    open({ accountId: null });
    await new Promise((r) => setTimeout(r, 400));
    expect(countMatchingForRule).not.toHaveBeenCalled();
  });
});

describe("forwarded mail", () => {
  const forwarded = {
    fromAddr: "ken@old-employer.test",
    originAddr: "alerts@manheim.test",
    isForwarded: true,
    fromName: '"Manheim" via Old User Ken',
  };

  it("defaults to the original sender, not the forwarder", () => {
    // A rule on the forwarder matches everything that mailbox relays.
    open(forwarded);
    expect(screen.getByLabelText("Sender address")).toHaveValue("alerts@manheim.test");
    expect(screen.getByRole("button", { name: /Original: Manheim/ })).toBeInTheDocument();
  });

  it("saves an origin_from rule so it matches however the mail is forwarded", async () => {
    const { user } = open(forwarded);
    await user.click(screen.getByRole("button", { name: "Newsletters" }));
    await user.click(saveButton());

    await waitFor(() => expect(addFolderRule).toHaveBeenCalled());
    expect(ruleData()).toMatchObject({
      field: "origin_from",
      value: "alerts@manheim.test",
    });
  });

  it("saves a plain from rule when the user switches back to the forwarder", async () => {
    const { user } = open(forwarded);
    await user.click(screen.getByRole("button", { name: /Via Old User Ken/ }));
    expect(screen.getByLabelText("Sender address")).toHaveValue("ken@old-employer.test");

    await user.click(screen.getByRole("button", { name: "Newsletters" }));
    await user.click(saveButton());

    await waitFor(() => expect(addFolderRule).toHaveBeenCalled());
    expect(ruleData()).toMatchObject({ field: "from", value: "ken@old-employer.test" });
  });

  it("uses origin_domain when matching on the domain of a forwarded sender", async () => {
    const { user } = open(forwarded);
    await user.click(screen.getByRole("button", { name: /Domain/ }));
    await user.click(screen.getByRole("button", { name: "Newsletters" }));
    await user.click(saveButton());

    await waitFor(() => expect(addFolderRule).toHaveBeenCalled());
    expect(ruleData()).toMatchObject({ field: "origin_domain", value: "manheim.test" });
  });

  it("warns when the mail was relayed but no header named the real sender", () => {
    // Nothing to switch to here — the only honest thing is to say so
    // before the user creates a rule on the relay.
    open({ fromAddr: "relay@old-employer.test", isForwarded: true, originAddr: null });
    expect(screen.getByText(/relayed by relay@old-employer\.test/)).toBeInTheDocument();
    expect(screen.getByText(/matches everything that address forwards/)).toBeInTheDocument();
  });

  it("names both parties in the warning when the display name carries them", () => {
    open({ fromAddr: "ken@old.test", fromName: '"Manheim" via Old User Ken', isForwarded: false });
    expect(
      screen.getByText(/reached you from Manheim, relayed by Old User Ken \(ken@old\.test\)/),
    ).toBeInTheDocument();
  });

  it("offers no sender switch for directly delivered mail", () => {
    open();
    expect(screen.queryByText("Which sender")).not.toBeInTheDocument();
  });
});

describe("saving a folder rule", () => {
  it("cannot save without a target folder", () => {
    open();
    expect(saveButton()).toBeDisabled();
  });

  it("cannot save an empty value", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: "Newsletters" }));
    await user.clear(valueBox());
    expect(saveButton()).toBeDisabled();
  });

  it("will not route mail back into the folder it is already in", () => {
    open({ currentFolderId: "f1" });
    expect(screen.getByRole("button", { name: /Newsletters/ })).toBeDisabled();
  });

  it("trims the value, names the folder, and invalidates the mail caches", async () => {
    const { user } = open();
    await user.clear(valueBox());
    await user.type(valueBox(), "  news@acme.test  ");
    await user.click(screen.getByRole("button", { name: "Newsletters" }));
    await user.click(saveButton());

    await waitFor(() => expect(addFolderRule).toHaveBeenCalled());
    expect(ruleData()).toEqual({
      folder_id: "f1",
      field: "from",
      value: "news@acme.test",
      op: "contains",
    });
    expect(toast.success).toHaveBeenCalledWith("Future matches → Newsletters");
    expect(onOpenChange).toHaveBeenCalledWith(false);

    const keys = invalidateQueries.mock.calls.map(
      (c) => (c[0] as { queryKey: string[] }).queryKey[0],
    );
    expect(keys).toEqual(expect.arrayContaining(["folder-filters", "emails", "emails-summary"]));
  });

  it("says so when the rule already existed rather than claiming a new one", async () => {
    addFolderRule.mockResolvedValue({ already: true });
    const { user } = open();
    await user.click(screen.getByRole("button", { name: "Newsletters" }));
    await user.click(saveButton());

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Rule already routed to Newsletters"),
    );
  });

  it("reports a failed save and keeps the drawer open", async () => {
    addFolderRule.mockRejectedValue(new Error("Folder not found"));
    const { user } = open();
    await user.click(screen.getByRole("button", { name: "Newsletters" }));
    await user.click(saveButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Folder not found"));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("applying to past mail", () => {
  const selectPast = async (user: ReturnType<typeof renderWithQuery>["user"]) => {
    await user.click(screen.getByRole("button", { name: "Newsletters" }));
    await user.click(screen.getByRole("radio", { name: /Future and past matches/ }));
  };

  it("does not touch past mail by default", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: "Newsletters" }));
    await user.click(saveButton());

    await waitFor(() => expect(addFolderRule).toHaveBeenCalled());
    expect(applyFilterRuleToPast).not.toHaveBeenCalled();
  });

  it("moves past matches with the same field and op the rule uses", async () => {
    applyFilterRuleToPast.mockResolvedValue({ moved: 4, archived: 0, failed: 0 });
    const { user } = open();
    await selectPast(user);
    await user.click(saveButton());

    await waitFor(() => expect(applyFilterRuleToPast).toHaveBeenCalled());
    expect((applyFilterRuleToPast.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      account_id: "acct-1",
      to_folder_id: "f1",
      field: "from",
      op: "contains",
      value: "news@acme.test",
      archive: false,
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Past emails → Newsletters: 4 moved"),
    );
  });

  it("archives past matches only when asked", async () => {
    const { user } = open();
    await selectPast(user);
    await user.click(screen.getByRole("checkbox", { name: /Also archive them/ }));
    await user.click(saveButton());

    await waitFor(() => expect(applyFilterRuleToPast).toHaveBeenCalled());
    expect(
      (applyFilterRuleToPast.mock.calls[0]![0] as { data: { archive: boolean } }).data.archive,
    ).toBe(true);
  });

  it("reports moved, archived and failed counts together", async () => {
    applyFilterRuleToPast.mockResolvedValue({ moved: 3, archived: 2, failed: 1 });
    const { user } = open();
    await selectPast(user);
    await user.click(saveButton());

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Past emails → Newsletters: 3 moved · 2 archived · 1 failed",
      ),
    );
  });

  it("says nothing when the past pass moved nothing", async () => {
    applyFilterRuleToPast.mockResolvedValue({ moved: 0, archived: 0, failed: 0 });
    const { user } = open();
    await selectPast(user);
    await user.click(saveButton());

    await waitFor(() => expect(applyFilterRuleToPast).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining("Past emails"));
  });

  it("makes clear the rule was saved when only the past pass failed", async () => {
    // It runs after the drawer closes, so an undifferentiated error would
    // read as the whole thing having failed.
    applyFilterRuleToPast.mockRejectedValue(new Error("rate limited"));
    const { user } = open();
    await selectPast(user);
    await user.click(saveButton());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Rule saved, but moving past emails failed: rate limited",
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Future matches → Newsletters");
  });
});

describe("inbox override mode", () => {
  const chooseInbox = async (user: ReturnType<typeof renderWithQuery>["user"]) =>
    user.click(screen.getByRole("button", { name: /Inbox — always show/ }));

  it("switches the button to the inbox wording", async () => {
    const { user } = open();
    await chooseInbox(user);
    expect(screen.getByRole("button", { name: "Add to inbox list" })).toBeInTheDocument();
  });

  it("moves a subject rule onto the sender, since overrides cannot match subjects", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: /Subject/ }));
    await chooseInbox(user);

    await waitFor(() =>
      expect(screen.getByLabelText("Sender address")).toHaveValue("news@acme.test"),
    );
    expect(screen.getByRole("button", { name: /Subject/ })).toBeDisabled();
  });

  it("forces an exact match", async () => {
    const { user } = open();
    await chooseInbox(user);
    await waitFor(() =>
      expect(countMatchingForRule).toHaveBeenLastCalledWith({
        data: { account_id: "acct-1", field: "from", op: "equals", value: "news@acme.test" },
      }),
    );
  });

  it("turns off origin matching, because overrides match the delivered sender", async () => {
    const { user } = open({
      fromAddr: "ken@old.test",
      originAddr: "alerts@manheim.test",
      isForwarded: true,
    });
    await chooseInbox(user);
    await user.click(saveButton());

    await waitFor(() => expect(addInboxOverride).toHaveBeenCalled());
    expect((addInboxOverride.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      value: "ken@old.test",
      match_type: "email",
    });
  });

  it("saves a domain override as a domain match", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: /Domain/ }));
    await chooseInbox(user);
    await user.click(saveButton());

    await waitFor(() => expect(addInboxOverride).toHaveBeenCalled());
    expect((addInboxOverride.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      value: "acme.test",
      match_type: "domain",
    });
    expect(addFolderRule).not.toHaveBeenCalled();
  });

  it("says so when the sender was already on the list", async () => {
    addInboxOverride.mockResolvedValue({ already: true });
    const { user } = open();
    await chooseInbox(user);
    await user.click(saveButton());

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Already on the inbox list"));
  });

  it("strips the folder label from past mail when asked", async () => {
    stripFolderLabelPast.mockResolvedValue({ stripped_count: 2 });
    const { user } = open();
    await chooseInbox(user);
    await user.click(screen.getByRole("radio", { name: /Future and past matches/ }));
    await user.click(saveButton());

    await waitFor(() => expect(stripFolderLabelPast).toHaveBeenCalled());
    expect((stripFolderLabelPast.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      value: "news@acme.test",
      match_type: "email",
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Cleaned 2 past emails"));
  });

  it("distinguishes an override that saved from a past pass that did not", async () => {
    stripFolderLabelPast.mockRejectedValue(new Error("quota"));
    const { user } = open();
    await chooseInbox(user);
    await user.click(screen.getByRole("radio", { name: /Future and past matches/ }));
    await user.click(saveButton());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Override saved, but cleaning past emails failed: quota",
      ),
    );
  });

  it("offers no archive option, since nothing is being moved out of the inbox", async () => {
    const { user } = open();
    await chooseInbox(user);
    await user.click(screen.getByRole("radio", { name: /Future and past matches/ }));
    expect(screen.queryByRole("checkbox", { name: /Also archive them/ })).not.toBeInTheDocument();
  });
});

describe("auto mark-read scoping", () => {
  const pickFolder = async (user: ReturnType<typeof renderWithQuery>["user"]) =>
    user.click(screen.getByRole("button", { name: "Newsletters" }));

  it("is offered only for a folder target with a sender or domain rule", async () => {
    const { user } = open();
    expect(screen.queryByText("Mark as read")).not.toBeInTheDocument();

    await pickFolder(user);
    expect(await screen.findByText("Mark as read")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Subject/ }));
    expect(screen.queryByText("Mark as read")).not.toBeInTheDocument();
  });

  it("seeds to what the folder already does", async () => {
    getFolderMarkReadDecision.mockResolvedValue({
      auto_mark_read: true,
      mark_read_mode: "all",
      listed: false,
      would_mark_read: true,
    });
    const { user } = open();
    await pickFolder(user);

    expect(await screen.findByText(/will be marked read automatically/)).toBeInTheDocument();
    expect(screen.queryByText(/updates the folder's auto mark-read settings/)).toBeNull();
  });

  it("writes nothing when the user leaves the control alone", async () => {
    const { user } = open();
    await pickFolder(user);
    await screen.findByRole("button", { name: /Mark read/ }, { timeout: 2000 });
    await user.click(saveButton());

    await waitFor(() => expect(addFolderRule).toHaveBeenCalled());
    // Opening this drawer must never reshape a folder's settings by itself.
    expect(setSenderMarkRead).not.toHaveBeenCalled();
  });

  it("writes the folder setting once the user changes it, and says which way", async () => {
    const { user } = open();
    await pickFolder(user);

    await user.click(await screen.findByRole("button", { name: /Mark read/ }, { timeout: 2000 }));
    expect(screen.getByText(/updates the folder's auto mark-read settings/)).toBeInTheDocument();

    await user.click(saveButton());

    await waitFor(() => expect(setSenderMarkRead).toHaveBeenCalled());
    expect((setSenderMarkRead.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      folder_id: "f1",
      value: "news@acme.test",
      mark_read: true,
    });
    expect(toast.success).toHaveBeenCalledWith("Newsletters: this sender will be marked read");
  });

  it("makes clear the rule saved when only the mark-read write failed", async () => {
    setSenderMarkRead.mockRejectedValue(new Error("folder locked"));
    const { user } = open();
    await pickFolder(user);
    await user.click(await screen.findByRole("button", { name: /Mark read/ }, { timeout: 2000 }));
    await user.click(saveButton());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Rule saved, but the mark-read setting failed: folder locked",
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Future matches → Newsletters");
  });

  it("hides the control rather than guessing when the folder lookup fails", async () => {
    getFolderMarkReadDecision.mockRejectedValue(new Error("nope"));
    const { user } = open();
    await pickFolder(user);
    await waitFor(() => expect(getFolderMarkReadDecision).toHaveBeenCalled());
    expect(screen.getByText("Checking folder settings…")).toBeInTheDocument();
  });
});

describe("cancelling", () => {
  it("closes without writing anything", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: "Newsletters" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(addFolderRule).not.toHaveBeenCalled();
    expect(addInboxOverride).not.toHaveBeenCalled();
  });

  it("says there are no folders rather than showing an empty list", () => {
    open({ folders: [] });
    expect(screen.getByText("No folders yet.")).toBeInTheDocument();
  });
});
