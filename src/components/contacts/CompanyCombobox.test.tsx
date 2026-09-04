// CompanyCombobox — pick an existing company or create one inline.
//
// Creating a company from a free-text box is where duplicates come from,
// so the contracts worth pinning are the ones that stop that happening:
//
//   * typing a name that already exists selects it rather than creating a
//     second row — and the "Create" option is not even offered, so there
//     is nothing to click by mistake,
//   * the match is case-insensitive, since "Acme" and "acme" are the same
//     company to a person and two rows to a database,
//   * the name is validated to the SAME bounds the server enforces, so an
//     over-long name is refused inline rather than by a round trip,
//   * both the picker cache and the company list views are invalidated on
//     create, or the new company is invisible until a reload,
//   * the search is client-side over an already-fetched list and capped,
//     so a large account does not render thousands of rows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithQuery, mockReactStart, makeToastSpies } from "@/lib/__fixtures__/ui";

vi.mock("@tanstack/react-start", () => mockReactStart());

const { toast, module: sonnerModule } = makeToastSpies();
vi.mock("sonner", () => sonnerModule());

const listCompanies = vi.fn();
const createCompany = vi.fn();
vi.mock("@/lib/companies/companies.functions", () => ({
  listCompanies: (...a: unknown[]) => listCompanies(...a),
  createCompany: (...a: unknown[]) => createCompany(...a),
}));

const invalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => ({ invalidateQueries }) };
});

const { CompanyCombobox } = await import("./CompanyCombobox");

const onChange = vi.fn();

const company = (id: string, name: string, member_count = 0) => ({ id, name, member_count });

function render(value = "") {
  return renderWithQuery(<CompanyCombobox value={value} onChange={onChange} />);
}

const trigger = () => screen.getByRole("combobox");
const searchBox = () => screen.getByPlaceholderText("Search or type new…");

beforeEach(() => {
  listCompanies.mockResolvedValue({
    companies: [company("co1", "Acme", 4), company("co2", "Globex"), company("co3", "Initech")],
  });
  createCompany.mockResolvedValue({ id: "new", name: "Umbrella" });
});

describe("the trigger", () => {
  it("shows a placeholder until a company is chosen", () => {
    render();
    expect(trigger()).toHaveTextContent("Select or create a company");
  });

  it("shows the chosen company once there is one", () => {
    render("Acme");
    expect(trigger()).toHaveTextContent("Acme");
  });

  it("honours a caller-supplied placeholder", () => {
    renderWithQuery(<CompanyCombobox value="" onChange={onChange} placeholder="Employer" />);
    expect(trigger()).toHaveTextContent("Employer");
  });
});

describe("choosing an existing company", () => {
  it("lists every company with its member count", async () => {
    const { user } = render();
    await user.click(trigger());

    const list = within(await screen.findByRole("listbox"));
    expect(await screen.findByRole("option", { name: /Acme/ })).toBeInTheDocument();
    expect(list.getByText("4")).toBeInTheDocument();
    // A company nobody is in shows no count rather than a zero.
    expect(list.getByRole("option", { name: /Globex/ })).not.toHaveTextContent("0");
  });

  it("reports the picked name and closes", async () => {
    const { user } = render();
    await user.click(trigger());
    await user.click(await screen.findByRole("option", { name: /Globex/ }));

    expect(onChange).toHaveBeenCalledWith("Globex");
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search or type new…")).not.toBeInTheDocument(),
    );
  });

  it("filters as the user types, case-insensitively", async () => {
    const { user } = render();
    await user.click(trigger());
    await user.type(await screen.findByPlaceholderText("Search or type new…"), "glob");

    expect(await screen.findByRole("option", { name: /Globex/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Initech/ })).not.toBeInTheDocument();
  });

  it("says so when the account has no companies at all", async () => {
    listCompanies.mockResolvedValue({ companies: [] });
    const { user } = render();
    await user.click(trigger());
    expect(await screen.findByText("No companies yet.")).toBeInTheDocument();
  });

  it("offers a clear action only once something is selected", async () => {
    const { user, unmount } = render();
    await user.click(trigger());
    expect(screen.queryByRole("option", { name: "Clear company" })).not.toBeInTheDocument();
    unmount();

    const second = render("Acme");
    await second.user.click(trigger());
    await second.user.click(await screen.findByRole("option", { name: "Clear company" }));
    expect(onChange).toHaveBeenCalledWith("");
  });
});

describe("creating a company", () => {
  it("offers a create option for a name that does not exist", async () => {
    const { user } = render();
    await user.click(trigger());
    await user.type(searchBox(), "Umbrella");

    expect(await screen.findByRole("option", { name: /Create "Umbrella"/ })).toBeInTheDocument();
  });

  it("creates the trimmed name and adopts it", async () => {
    const { user } = render();
    await user.click(trigger());
    await user.type(searchBox(), "  Umbrella  ");
    await user.click(await screen.findByRole("option", { name: /Create "Umbrella"/ }));

    await waitFor(() => expect(createCompany).toHaveBeenCalled());
    expect((createCompany.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      name: "Umbrella",
    });
    expect(onChange).toHaveBeenCalledWith("Umbrella");
    expect(toast.success).toHaveBeenCalledWith('Created "Umbrella"');
  });

  it("refreshes the company caches so the new row is visible at once", async () => {
    const { user } = render();
    await user.click(trigger());
    await user.type(searchBox(), "Umbrella");
    await user.click(await screen.findByRole("option", { name: /Create "Umbrella"/ }));

    await waitFor(() => expect(invalidateQueries).toHaveBeenCalled());
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["companies"] });
  });

  it("offers no create option for a name that already exists", async () => {
    // Nothing to click by mistake — this is the duplicate guard.
    const { user } = render();
    await user.click(trigger());
    await user.type(searchBox(), "Acme");

    expect(await screen.findByRole("option", { name: /Acme/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Create "/ })).not.toBeInTheDocument();
  });

  it("treats a differently-cased existing name as the same company", async () => {
    const { user } = render();
    await user.click(trigger());
    await user.type(searchBox(), "aCmE");

    // "Acme" and "acme" are one company to a person and two rows to a
    // database, so no create option is offered here either.
    expect(screen.queryByRole("option", { name: /Create "/ })).not.toBeInTheDocument();
  });

  it("offers no create option for whitespace alone", async () => {
    const { user } = render();
    await user.click(trigger());
    await user.type(searchBox(), "   ");
    expect(screen.queryByRole("option", { name: /Create "/ })).not.toBeInTheDocument();
  });

  it("refuses an over-long name inline, before the network", async () => {
    // Same bound the server validator enforces.
    const { user } = render();
    await user.click(trigger());
    await user.click(searchBox());
    await user.paste("x".repeat(201));
    await user.click(await screen.findByRole("option", { name: /Create "/ }));

    expect(
      await screen.findByText("Company name must be under 200 characters"),
    ).toBeInTheDocument();
    expect(createCompany).not.toHaveBeenCalled();
  });

  it("shows the server's message when the create is rejected", async () => {
    createCompany.mockRejectedValue(new Error("A company with that name exists"));
    const { user } = render();
    await user.click(trigger());
    await user.type(searchBox(), "Umbrella");
    await user.click(await screen.findByRole("option", { name: /Create "Umbrella"/ }));

    expect(await screen.findByText("A company with that name exists")).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith("A company with that name exists");
    // The list stays open so the user can adjust the name.
    expect(searchBox()).toBeInTheDocument();
  });

  it("clears the error as soon as the name changes", async () => {
    createCompany.mockRejectedValue(new Error("A company with that name exists"));
    const { user } = render();
    await user.click(trigger());
    await user.type(searchBox(), "Umbrella");
    await user.click(await screen.findByRole("option", { name: /Create "Umbrella"/ }));
    await screen.findByText("A company with that name exists");

    await user.type(searchBox(), "2");

    expect(screen.queryByText("A company with that name exists")).not.toBeInTheDocument();
  });

  it("falls back to a generic message for a non-Error rejection", async () => {
    createCompany.mockRejectedValue("boom");
    const { user } = render();
    await user.click(trigger());
    await user.type(searchBox(), "Umbrella");
    await user.click(await screen.findByRole("option", { name: /Create "Umbrella"/ }));

    expect(await screen.findByText("Failed to create company")).toBeInTheDocument();
  });
});
