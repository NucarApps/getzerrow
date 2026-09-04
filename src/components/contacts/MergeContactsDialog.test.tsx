// MergeContactsDialog — the manual 2-to-6 contact merge.
//
// The precedence rules (which contact's value survives, how phones and
// emails union) are pure and covered in src/lib/ui/merge-contacts.test.ts.
// What this file covers is the wiring around them, which that extraction
// cannot reach — and it matters more than usual because a merge DELETES
// the contacts that were not chosen:
//
//   * the survivor picker is the gate: the Merge button stays disabled
//     until a primary is chosen, and the request always carries the
//     currently-selected one,
//   * a field with nothing to choose between is not offered — every
//     contact agreeing, or only one holding a value, means no radio
//     group, so the user is not asked to arbitrate a non-conflict,
//   * "Primary" for a phone or email is only selectable while that row is
//     kept; unchecking a row must not leave it as the survivor's primary,
//   * the whole group union is offered and a chip toggles exclusion,
//   * after a merge the group caches are invalidated too — contacts
//     realtime watches the contacts table only, so without that the label
//     chips and counts stay stale,
//   * a failed merge surfaces the server's own message and leaves the
//     dialog open, since the user's field selections are expensive to
//     redo.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithQuery, mockReactStart, makeToastSpies } from "@/lib/__fixtures__/ui";

vi.mock("@tanstack/react-start", () => mockReactStart());

const { toast, module: sonnerModule } = makeToastSpies();
vi.mock("sonner", () => sonnerModule());

const getContactsMergePayload = vi.fn();
const mergeContactsManual = vi.fn();
vi.mock("@/lib/contacts/dedup.functions", () => ({
  getContactsMergePayload: (...a: unknown[]) => getContactsMergePayload(...a),
  mergeContactsManual: (...a: unknown[]) => mergeContactsManual(...a),
}));

const invalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries }),
  };
});

const { MergeContactsDialog } = await import("./MergeContactsDialog");

const onOpenChange = vi.fn();
const onMerged = vi.fn();

type Contact = {
  id: string;
  name: string | null;
  email: string | null;
  company?: string | null;
  title?: string | null;
  notes?: string | null;
};

const ANN: Contact = { id: "c1", name: "Ann Lee", email: "ann@acme.test", company: "Acme" };
const ANNE: Contact = { id: "c2", name: "Anne Lee", email: "anne@acme.test", company: "Acme" };

function payload(
  over: Partial<{
    contacts: Contact[];
    emails: Array<{
      id: string;
      contact_id: string;
      label: string;
      address: string;
      is_primary: boolean;
    }>;
    phones: Array<{
      id: string;
      contact_id: string;
      label: string;
      number: string;
      is_primary: boolean;
    }>;
    memberships: Array<{ group_id: string }>;
    groups: Array<{ id: string; name: string }>;
  }> = {},
) {
  return {
    contacts: [ANN, ANNE],
    emails: [],
    phones: [],
    memberships: [],
    groups: [],
    ...over,
  };
}

function open(ids = ["c1", "c2"]) {
  return renderWithQuery(
    <MergeContactsDialog open onOpenChange={onOpenChange} contactIds={ids} onMerged={onMerged} />,
  );
}

/** Wait for the payload query to resolve and the picker to render. */
const survivorPicker = () =>
  screen.findByRole("heading", { name: "Survivor contact" }).then(() => undefined);

/** Scope queries to one <section>. Every section repeats the contacts'
 * names, so an unscoped role query matches several radios at once. */
function section(heading: string) {
  return within(screen.getByRole("heading", { name: heading }).closest("section")!);
}

beforeEach(() => {
  getContactsMergePayload.mockResolvedValue(payload());
  mergeContactsManual.mockResolvedValue({ survivorId: "c1", deletedCount: 1 });
});

describe("loading and the survivor gate", () => {
  it("shows a loading state and no merge target until the payload arrives", async () => {
    let resolve!: (v: unknown) => void;
    getContactsMergePayload.mockReturnValue(new Promise((r) => (resolve = r)));

    open();

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();

    resolve(payload());
    await survivorPicker();
  });

  it("names how many contacts are being merged", async () => {
    open(["c1", "c2", "c3"]);
    expect(screen.getByText("Merge 3 contacts")).toBeInTheDocument();
  });

  it("does not fetch for fewer than two contacts", () => {
    open(["c1"]);
    expect(getContactsMergePayload).not.toHaveBeenCalled();
  });

  it("warns that the other contacts are deleted", async () => {
    open();
    await survivorPicker();
    expect(screen.getByText("The others are deleted after merging.")).toBeInTheDocument();
  });

  it("enables Merge once a survivor is seeded and sends that survivor", async () => {
    const { user } = open();
    await survivorPicker();

    const merge = screen.getByRole("button", { name: "Merge" });
    await waitFor(() => expect(merge).toBeEnabled());
    await user.click(merge);

    await waitFor(() => expect(mergeContactsManual).toHaveBeenCalled());
    const req = mergeContactsManual.mock.calls[0]![0] as { data: { primaryId: string } };
    expect(req.data.primaryId).toBe("c1");
  });

  it("merges into whichever survivor the user picks", async () => {
    const { user } = open();
    await survivorPicker();

    await user.click(section("Survivor contact").getByRole("radio", { name: /Anne Lee/ }));
    await user.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(mergeContactsManual).toHaveBeenCalled());
    const req = mergeContactsManual.mock.calls[0]![0] as {
      data: { primaryId: string; loserIds: string[] };
    };
    expect(req.data.primaryId).toBe("c2");
    expect(req.data.loserIds).toEqual(["c1"]);
  });
});

describe("field arbitration", () => {
  it("does not ask about a field every contact agrees on", async () => {
    // Both are at Acme — offering a choice here is noise, and the user
    // clicking through it is a chance to pick wrong.
    open();
    await survivorPicker();
    expect(screen.queryByText("Company (text)")).not.toBeInTheDocument();
  });

  it("asks about a field the contacts disagree on", async () => {
    getContactsMergePayload.mockResolvedValue(
      payload({ contacts: [ANN, { ...ANNE, company: "Globex" }] }),
    );
    open();
    await survivorPicker();

    const group = within(screen.getByText("Company (text)").closest("div.rounded-md")!);
    expect(group.getByRole("radio", { name: /Acme/ })).toBeInTheDocument();
    expect(group.getByRole("radio", { name: /Globex/ })).toBeInTheDocument();
  });

  it("asks about a field only one contact holds", async () => {
    // One value and one blank IS a conflict worth surfacing: picking the
    // blank contact as survivor would otherwise drop the title silently.
    getContactsMergePayload.mockResolvedValue(
      payload({ contacts: [{ ...ANN, title: "CTO" }, ANNE] }),
    );
    open();
    await survivorPicker();
    expect(screen.getByText("Title")).toBeInTheDocument();
  });

  it("sends the field value the user picked, not the survivor's", async () => {
    getContactsMergePayload.mockResolvedValue(
      payload({ contacts: [ANN, { ...ANNE, company: "Globex" }] }),
    );
    const { user } = open();
    await survivorPicker();

    const group = within(screen.getByText("Company (text)").closest("div.rounded-md")!);
    await user.click(group.getByRole("radio", { name: /Globex/ }));
    await user.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(mergeContactsManual).toHaveBeenCalled());
    const req = mergeContactsManual.mock.calls[0]![0] as {
      data: { primaryId: string; fields: Record<string, unknown> };
    };
    expect(req.data.primaryId).toBe("c1");
    expect(req.data.fields.company).toBe("Globex");
  });
});

describe("notes", () => {
  it("offers no notes section when nobody has notes", async () => {
    open();
    await survivorPicker();
    expect(screen.queryByRole("heading", { name: "Notes" })).not.toBeInTheDocument();
  });

  it("offers only the contacts that actually have notes", async () => {
    getContactsMergePayload.mockResolvedValue(
      payload({ contacts: [{ ...ANN, notes: "Met at conf" }, ANNE] }),
    );
    open();
    await survivorPicker();

    const notes = section("Notes");
    expect(notes.getByText("Met at conf")).toBeInTheDocument();
    expect(notes.getAllByRole("radio")).toHaveLength(1);
  });
});

describe("emails and phones", () => {
  const emails = [
    { id: "e1", contact_id: "c1", label: "work", address: "ann@acme.test", is_primary: true },
    { id: "e2", contact_id: "c2", label: "home", address: "anne@home.test", is_primary: false },
  ];
  const phones = [
    { id: "p1", contact_id: "c1", label: "mobile", number: "+15550001", is_primary: true },
    { id: "p2", contact_id: "c2", label: "work", number: "+15550002", is_primary: false },
  ];

  it("lists every address with the contact it came from", async () => {
    getContactsMergePayload.mockResolvedValue(payload({ emails }));
    open();
    await survivorPicker();

    const list = section("Emails");
    expect(list.getByText(/ann@acme\.test/)).toBeInTheDocument();
    expect(list.getByText(/anne@home\.test/)).toBeInTheDocument();
    expect(list.getByText("from Anne Lee")).toBeInTheDocument();
  });

  it("only lets a kept address be the primary one", async () => {
    getContactsMergePayload.mockResolvedValue(payload({ emails }));
    const { user } = open();
    await survivorPicker();

    const row = within(
      section("Emails")
        .getByText(/anne@home\.test/)
        .closest("div.flex")!,
    );
    // Every address is kept by default, so Primary starts selectable.
    expect(row.getByRole("radio")).toBeEnabled();

    await user.click(row.getByRole("checkbox"));

    // Dropping the address must drop its eligibility to be primary — a
    // survivor whose primary email is one that was not kept has no primary
    // at all.
    expect(row.getByRole("radio")).toBeDisabled();
  });

  it("drops an unchecked address from the merge request", async () => {
    getContactsMergePayload.mockResolvedValue(payload({ emails }));
    const { user } = open();
    await survivorPicker();

    const row = within(
      section("Emails")
        .getByText(/ann@acme\.test/)
        .closest("div.flex")!,
    );
    await user.click(row.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(mergeContactsManual).toHaveBeenCalled());
    const req = mergeContactsManual.mock.calls[0]![0] as {
      data: { emails: Array<{ address: string }> };
    };
    expect(req.data.emails.map((e) => e.address)).not.toContain("ann@acme.test");
  });

  it("applies the same keep/primary rules to phones", async () => {
    getContactsMergePayload.mockResolvedValue(payload({ phones }));
    const { user } = open();
    await survivorPicker();

    const row = within(
      section("Phones")
        .getByText(/\+15550002/)
        .closest("div.flex")!,
    );
    expect(row.getByRole("radio")).toBeEnabled();
    await user.click(row.getByRole("radio"));
    await user.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(mergeContactsManual).toHaveBeenCalled());
    const req = mergeContactsManual.mock.calls[0]![0] as {
      data: { phones: Array<{ number: string; is_primary: boolean }> };
    };
    expect(req.data.phones.find((p) => p.number === "+15550002")?.is_primary).toBe(true);
  });

  it("renders no email or phone section when there are none", async () => {
    open();
    await survivorPicker();
    expect(screen.queryByRole("heading", { name: "Emails" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Phones" })).not.toBeInTheDocument();
  });
});

describe("group union", () => {
  const withGroups = () =>
    payload({
      memberships: [{ group_id: "g1" }, { group_id: "g2" }, { group_id: "g1" }],
      groups: [
        { id: "g1", name: "Customers" },
        { id: "g2", name: "Prospects" },
      ],
    });

  it("offers each label once, however many contacts carry it", async () => {
    getContactsMergePayload.mockResolvedValue(withGroups());
    open();
    await survivorPicker();

    expect(screen.getAllByText("Customers")).toHaveLength(1);
    expect(screen.getByText("Prospects")).toBeInTheDocument();
  });

  it("drops a label the user unchecks from the survivor", async () => {
    getContactsMergePayload.mockResolvedValue(withGroups());
    const { user } = open();
    await survivorPicker();

    await user.click(section("Groups").getByText("Prospects"));
    await user.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(mergeContactsManual).toHaveBeenCalled());
    // The request names what to EXCLUDE, so the survivor keeps everything
    // else without the dialog having to enumerate the union.
    const req = mergeContactsManual.mock.calls[0]![0] as { data: { excludedGroupIds: string[] } };
    expect(req.data.excludedGroupIds).toEqual(["g2"]);
  });

  it("skips a membership whose group is not in the payload", async () => {
    getContactsMergePayload.mockResolvedValue(
      payload({ memberships: [{ group_id: "orphan" }], groups: [] }),
    );
    open();
    await survivorPicker();
    expect(screen.queryByRole("heading", { name: "Groups" })).toBeInTheDocument();
  });

  it("renders no group section when nobody has labels", async () => {
    open();
    await survivorPicker();
    expect(screen.queryByRole("heading", { name: "Groups" })).not.toBeInTheDocument();
  });
});

describe("outcome", () => {
  it("reports the survivor count, closes, and invalidates the group caches", async () => {
    mergeContactsManual.mockResolvedValue({ survivorId: "c1", deletedCount: 2 });
    const { user } = open();
    await survivorPicker();
    await user.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Merged 3 contacts into one"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onMerged).toHaveBeenCalledWith("c1");

    const keys = invalidateQueries.mock.calls.map(
      (c) => (c[0] as { queryKey: string[] }).queryKey[0],
    );
    // contact-groups is the one that is easy to forget: contacts realtime
    // watches the contacts table, not contact_group_members.
    expect(keys).toEqual(
      expect.arrayContaining(["contacts", "contact", "contact-duplicates", "contact-groups"]),
    );
  });

  it("surfaces the server's message and keeps the dialog open on failure", async () => {
    mergeContactsManual.mockRejectedValue(new Error("Contacts belong to different users"));
    const { user } = open();
    await survivorPicker();
    await user.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Contacts belong to different users"),
    );
    // The field selections are expensive to redo — closing would lose them.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onMerged).not.toHaveBeenCalled();
  });

  it("falls back to a generic message for a non-Error rejection", async () => {
    mergeContactsManual.mockRejectedValue("boom");
    const { user } = open();
    await survivorPicker();
    await user.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Merge failed"));
  });

  it("cancels without merging", async () => {
    const { user } = open();
    await survivorPicker();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mergeContactsManual).not.toHaveBeenCalled();
  });
});
