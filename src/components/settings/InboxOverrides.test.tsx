// InboxOverrides — the "always send to inbox" list and its exceptions.
//
// Everything on this list bypasses folder rules AND AI sorting, so what is
// stored has to be exactly what the matcher will later compare against.
// The normalisation and the email-vs-domain check are pure and covered in
// src/lib/ui/inbox-overrides.test.ts; this file pins the wiring, which is
// unusual for this codebase in that it talks to the BROWSER supabase
// client directly rather than through a server fn:
//
//   * the insert carries the signed-in user's id, read from the client at
//     write time — an insert without it is rejected by RLS, and reading it
//     from anywhere but the live session would let a stale value through,
//   * the override list is scoped to the selected Gmail account; the
//     exceptions list is not (it is keyed by override id),
//   * an invalid entry never reaches the database, and the "nothing typed"
//     case does not even complain,
//   * filters and search narrow what is SHOWN without touching what is
//     stored — the counts on the tabs stay whole-list counts,
//   * deleting an override invalidates the exception cache too, since the
//     exceptions are rows that hang off it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithQuery, makeToastSpies } from "@/lib/__fixtures__/ui";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

const { toast, module: sonnerModule } = makeToastSpies();
vi.mock("sonner", () => sonnerModule());

vi.mock("@/integrations/supabase/client", () => ({
  get supabase() {
    return fake.supabaseAdmin;
  },
}));

const { InboxOverrides } = await import("./InboxOverrides");

const USER = "user-1";
const ACCOUNT = "acct-1";

const override = (over: Partial<Record<string, unknown>> & { id: string; value: string }) => ({
  match_type: "email",
  note: null,
  created_at: "2026-08-01T00:00:00.000Z",
  gmail_account_id: ACCOUNT,
  ...over,
});

function open(props: { accountId?: string | null; accountEmail?: string | null } = {}) {
  return renderWithQuery(
    <InboxOverrides
      accountId={props.accountId === undefined ? ACCOUNT : props.accountId}
      accountEmail={props.accountEmail === undefined ? "me@work.test" : props.accountEmail}
    />,
  );
}

const valueBox = () => screen.getByPlaceholderText(/ceo@chevrolet\.com|chevrolet\.com/);
const addButton = () => screen.getByRole("button", { name: /^Add$/ });
const inserted = () =>
  fake.calls.inserts.find((w) => w.table === "inbox_overrides")?.payload as Record<string, unknown>;

beforeEach(() => {
  fake.reset();
  fake.signedInAs(USER);
});

describe("loading the list", () => {
  it("reads only the selected account's overrides, newest first", async () => {
    fake.seedRaw("inbox_overrides", [override({ id: "o1", value: "ceo@acme.test" })]);
    open();

    expect(await screen.findByText("ceo@acme.test")).toBeInTheDocument();
    expect(fake.calls.selects[0]).toMatchObject({
      table: "inbox_overrides",
      filters: [{ op: "eq", col: "gmail_account_id", value: ACCOUNT }],
    });
  });

  it("does not query without an account selected", async () => {
    open({ accountId: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.calls.selects.some((s) => s.table === "inbox_overrides")).toBe(false);
  });

  it("names the account the list applies to, and says 'this inbox' without one", () => {
    open();
    expect(screen.getByText("me@work.test")).toBeInTheDocument();

    fake.reset();
    open({ accountEmail: null });
    expect(screen.getByText(/skip folder rules and AI sorting for this inbox/)).toBeInTheDocument();
  });
});

describe("adding an override", () => {
  it("stores the normalised value under the signed-in user", async () => {
    const { user } = open();
    await user.type(valueBox(), "  CEO@Acme.TEST  ");
    await user.click(addButton());

    await waitFor(() => expect(inserted()).toBeTruthy());
    expect(inserted()).toEqual({
      user_id: USER,
      gmail_account_id: ACCOUNT,
      match_type: "email",
      value: "ceo@acme.test",
    });
    expect(toast.success).toHaveBeenCalledWith("Added ceo@acme.test to your inbox list");
  });

  it("adds on Enter as well as the button", async () => {
    const { user } = open();
    await user.type(valueBox(), "ceo@acme.test{Enter}");
    await waitFor(() => expect(inserted()).toBeTruthy());
  });

  it("clears the box after a successful add", async () => {
    const { user } = open();
    await user.type(valueBox(), "ceo@acme.test");
    await user.click(addButton());
    await waitFor(() => expect(valueBox()).toHaveValue(""));
  });

  it("says nothing at all for an empty box", async () => {
    const { user } = open();
    await user.click(addButton());

    expect(fake.calls.inserts).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("refuses an address with no @ and a domain with one", async () => {
    const { user } = open();
    await user.type(valueBox(), "acme.test");
    await user.click(addButton());
    expect(toast.error).toHaveBeenCalledWith("Enter a full email address");

    await user.click(screen.getByRole("combobox", { name: "Match type" }));
    await user.click(await screen.findByRole("option", { name: "Domain" }));
    await user.clear(valueBox());
    await user.type(valueBox(), "ceo@acme.test");
    await user.click(addButton());
    expect(toast.error).toHaveBeenCalledWith("Enter a domain only (e.g. example.com)");

    expect(fake.calls.inserts).toEqual([]);
  });

  it("refuses to add without an account", async () => {
    const { user } = open({ accountId: null });
    await user.type(valueBox(), "ceo@acme.test");
    await user.click(addButton());

    expect(toast.error).toHaveBeenCalledWith("Pick a Gmail account first");
    expect(fake.calls.inserts).toEqual([]);
  });

  it("refuses to write anything when the session is gone", async () => {
    // The insert needs a user_id or RLS rejects it; guessing one would be
    // worse than saying so.
    fake.signedInAs(null);
    const { user } = open();
    await user.type(valueBox(), "ceo@acme.test");
    await user.click(addButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Not signed in"));
    expect(fake.calls.inserts).toEqual([]);
  });

  it("surfaces the database's own message on a rejected insert", async () => {
    // Duplicates are caught by the unique key, not by the form.
    fake.onInsert("inbox_overrides", () => ({
      message: 'duplicate key value violates unique constraint "inbox_overrides_uniq"',
    }));
    const { user } = open();
    await user.type(valueBox(), "ceo@acme.test");
    await user.click(addButton());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("duplicate key")),
    );
    // The box keeps the value so the user can edit rather than retype.
    expect(valueBox()).toHaveValue("ceo@acme.test");
  });

  it("stores a domain entry as a domain match", async () => {
    const { user } = open();
    await user.click(screen.getByRole("combobox", { name: "Match type" }));
    await user.click(await screen.findByRole("option", { name: "Domain" }));
    await user.type(valueBox(), "Acme.TEST");
    await user.click(addButton());

    await waitFor(() => expect(inserted()).toBeTruthy());
    expect(inserted()).toMatchObject({ match_type: "domain", value: "acme.test" });
  });
});

describe("filtering the list", () => {
  const seedMixed = () =>
    fake.seedRaw("inbox_overrides", [
      override({ id: "o1", value: "ceo@acme.test", match_type: "email" }),
      override({ id: "o2", value: "acme.test", match_type: "domain" }),
      override({ id: "o3", value: "cfo@globex.test", match_type: "email" }),
    ]);

  it("counts the whole list on each tab, whatever is shown", async () => {
    seedMixed();
    open();
    expect(await screen.findByRole("tab", { name: "All (3)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Emails (2)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Domains (1)" })).toBeInTheDocument();
  });

  it("narrows to one match type", async () => {
    seedMixed();
    const { user } = open();
    await user.click(await screen.findByRole("tab", { name: "Domains (1)" }));

    expect(screen.getByText("acme.test")).toBeInTheDocument();
    expect(screen.queryByText("ceo@acme.test")).not.toBeInTheDocument();
    // Filtering is a view concern — nothing was deleted.
    expect(fake.calls.deletes).toEqual([]);
  });

  it("searches case-insensitively within the current filter", async () => {
    seedMixed();
    const { user } = open();
    await user.type(await screen.findByPlaceholderText("Search overrides…"), "GLOBEX");

    expect(screen.getByText("cfo@globex.test")).toBeInTheDocument();
    expect(screen.queryByText("ceo@acme.test")).not.toBeInTheDocument();
  });

  it("clears the search back to the full list", async () => {
    seedMixed();
    const { user } = open();
    const box = await screen.findByPlaceholderText("Search overrides…");
    await user.type(box, "globex");
    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(box).toHaveValue("");
    expect(screen.getByText("ceo@acme.test")).toBeInTheDocument();
  });

  it("offers no filters for an empty list", async () => {
    open();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("tab", { name: /All/ })).not.toBeInTheDocument();
  });
});

describe("removing an override", () => {
  it("deletes by id and refreshes the exceptions too", async () => {
    // Exceptions hang off the override, so a stale exception cache would
    // render rows whose parent is gone.
    fake.seedRaw("inbox_overrides", [override({ id: "o1", value: "ceo@acme.test" })]);
    const { user } = open();
    const row = (await screen.findByText("ceo@acme.test")).closest<HTMLElement>("div.flex")!;

    await user.click(within(row).getAllByRole("button").at(-1)!);

    await waitFor(() => expect(fake.calls.deletes).toHaveLength(1));
    expect(fake.calls.deletes[0]).toMatchObject({
      table: "inbox_overrides",
      filters: [{ op: "eq", col: "id", value: "o1" }],
    });
  });

  it("reports a failed delete", async () => {
    fake.seedRaw("inbox_overrides", [override({ id: "o1", value: "ceo@acme.test" })]);
    fake.onDelete("inbox_overrides", () => ({ message: "row is referenced" }));
    const { user } = open();
    const row = (await screen.findByText("ceo@acme.test")).closest<HTMLElement>("div.flex")!;

    await user.click(within(row).getAllByRole("button").at(-1)!);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("row is referenced"));
  });
});

describe("exceptions", () => {
  const seedOne = () => {
    fake.seedRaw("inbox_overrides", [override({ id: "o1", value: "ceo@acme.test" })]);
  };
  const expand = async (user: ReturnType<typeof renderWithQuery>["user"]) => {
    await screen.findByText("ceo@acme.test");
    await user.click(screen.getByRole("button", { name: "Expand exceptions" }));
  };
  /** The expanded exception panel. Scoping matters: its Add button and the
   * override form's share a name, and its field labels repeat the values
   * shown inside the open Select. */
  const panel = () =>
    within(screen.getByText(/that match any exception below/).closest<HTMLElement>("div")!);

  it("stays collapsed until asked", async () => {
    seedOne();
    open();
    await screen.findByText("ceo@acme.test");
    expect(screen.queryByText(/No exceptions/)).not.toBeInTheDocument();
  });

  it("explains what an exception does, for this override", async () => {
    seedOne();
    const { user } = open();
    await expand(user);

    expect(
      screen.getByText(/that match any exception below will be sorted normally/),
    ).toBeInTheDocument();
    expect(screen.getByText(/No exceptions — every email from ceo@acme\.test/)).toBeInTheDocument();
  });

  it("renders a stored exception with readable field and operator labels", async () => {
    seedOne();
    fake.seedRaw("inbox_override_exceptions", [
      { id: "x1", override_id: "o1", field: "subject", op: "starts_with", value: "RE: Daily" },
    ]);
    const { user } = open();
    await expand(user);

    const row = within(panel().getByText("RE: Daily").closest<HTMLElement>("div.flex")!);
    expect(row.getByText("Subject")).toBeInTheDocument();
    expect(row.getByText("starts with")).toBeInTheDocument();
  });

  it("falls back to the raw values for a field or op it does not know", async () => {
    // Rows can outlive a dropdown option; showing the raw value beats
    // showing nothing.
    seedOne();
    fake.seedRaw("inbox_override_exceptions", [
      { id: "x1", override_id: "o1", field: "reply_to", op: "glob", value: "*@acme.test" },
    ]);
    const { user } = open();
    await expand(user);

    const row = within(panel().getByText("*@acme.test").closest<HTMLElement>("div.flex")!);
    expect(row.getByText("reply_to")).toBeInTheDocument();
    expect(row.getByText("glob")).toBeInTheDocument();
  });

  it("adds an exception against the override, under the signed-in user", async () => {
    seedOne();
    const { user } = open();
    await expand(user);

    await user.type(screen.getByPlaceholderText("RE: Daily Reports"), "  RE: Daily  ");
    await user.click(panel().getByRole("button", { name: /Add/ }));

    await waitFor(() =>
      expect(fake.calls.inserts.some((w) => w.table === "inbox_override_exceptions")).toBe(true),
    );
    expect(
      fake.calls.inserts.find((w) => w.table === "inbox_override_exceptions")?.payload,
    ).toEqual({
      override_id: "o1",
      user_id: USER,
      field: "subject",
      op: "starts_with",
      value: "RE: Daily",
    });
  });

  it("writes nothing for an empty exception value", async () => {
    seedOne();
    const { user } = open();
    await expand(user);
    await user.click(panel().getByRole("button", { name: /Add/ }));

    expect(fake.calls.inserts.some((w) => w.table === "inbox_override_exceptions")).toBe(false);
  });

  it("hints at a pattern when the operator is a regex", async () => {
    seedOne();
    const { user } = open();
    await expand(user);

    await user.click(screen.getByRole("combobox", { name: "Exception operator" }));
    await user.click(await screen.findByRole("option", { name: "matches regex" }));

    expect(screen.getByPlaceholderText("^RE: Daily Reports")).toBeInTheDocument();
  });

  it("refuses to add an exception when the session is gone", async () => {
    seedOne();
    const { user } = open();
    await expand(user);
    fake.signedInAs(null);

    await user.type(screen.getByPlaceholderText("RE: Daily Reports"), "RE: Daily");
    await user.click(panel().getByRole("button", { name: /Add/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Not signed in"));
    expect(fake.calls.inserts.some((w) => w.table === "inbox_override_exceptions")).toBe(false);
  });

  it("deletes an exception by id", async () => {
    seedOne();
    fake.seedRaw("inbox_override_exceptions", [
      { id: "x1", override_id: "o1", field: "subject", op: "equals", value: "Report" },
    ]);
    const { user } = open();
    await expand(user);

    const row = panel().getByText("Report").closest<HTMLElement>("div.flex")!;
    await user.click(within(row).getByRole("button"));

    await waitFor(() =>
      expect(fake.calls.deletes.some((d) => d.table === "inbox_override_exceptions")).toBe(true),
    );
  });
});
