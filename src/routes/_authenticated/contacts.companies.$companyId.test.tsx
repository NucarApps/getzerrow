// The company detail page's danger zone — the first route component this
// suite covers.
//
// The form logic is pure and lives in src/lib/ui/company-form.ts with its
// own tests; what is untested here is the wiring, and the part of the
// wiring that matters is the two merges, because a merge DELETES a
// company and the two go in opposite directions:
//
//   * the danger-zone merge folds THIS company into the one the user
//     picked, then navigates to the target — this page's own company is
//     the one that stops existing,
//   * the domain-conflict merge folds the OTHER company into THIS one, so
//     the page the user is looking at stays valid and the domain they
//     were adding lands here.
//
// Getting either direction backwards deletes the wrong company, and both
// calls have the same signature, so nothing but a test distinguishes
// them.
//
// Also pinned: the merge is behind a preview the user must read, the
// preview cannot be confirmed while it is still loading or has failed,
// and the delete is behind its own confirm.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithQuery, mockReactStart, makeToastSpies } from "@/lib/__fixtures__/ui";

vi.mock("@tanstack/react-start", () => mockReactStart());

const { toast, module: sonnerModule } = makeToastSpies();
vi.mock("sonner", () => sonnerModule());

const COMPANY = "co-1";
const navigate = vi.fn();

// createFileRoute hands back the object the module assigns to `Route`, so
// the page's `Route.useParams()` resolves through this.
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useParams: () => ({ companyId: COMPANY }),
  }),
  Link: ({ to, children }: { to?: string; children?: React.ReactNode }) => (
    <a href={typeof to === "string" ? to : "#"}>{children}</a>
  ),
  useNavigate: () => navigate,
}));

const fns = {
  getCompany: vi.fn(),
  updateCompany: vi.fn(),
  addCompanyDomain: vi.fn(),
  removeCompanyDomain: vi.fn(),
  setCompanyTags: vi.fn(),
  mergeCompanies: vi.fn(),
  previewMergeCompanies: vi.fn(),
  deleteCompany: vi.fn(),
  listCompanies: vi.fn(),
  discoverCompanyDomains: vi.fn(),
};
vi.mock("@/lib/companies/companies.functions", () => fns);

vi.mock("@/lib/company-logo.functions", () => ({ listCompanyLogoChoices: vi.fn(async () => []) }));
vi.mock("@/lib/contact-groups.functions", () => ({
  createContactGroup: vi.fn(),
  listContactGroups: vi.fn(async () => ({ groups: [] })),
}));
vi.mock("@/lib/company-groups.functions", () => ({
  listCompanyLabels: vi.fn(async () => ({ groupIds: [] })),
  setCompanyLabels: vi.fn(),
}));
vi.mock("@/lib/companies/company-photo.functions", () => ({
  uploadCompanyPhoto: vi.fn(),
  removeCompanyPhoto: vi.fn(),
}));
vi.mock("@/lib/google-contacts/push-photo-now.functions", () => ({
  pushCompanyPhotoToGoogleNow: vi.fn(),
}));
vi.mock("@/lib/companies/company-people.functions", () => ({
  findCompanyPeopleByDomain: vi.fn(async () => ({ people: [] })),
  addCompanyPeople: vi.fn(),
  enhanceContactWithNewEmail: vi.fn(),
}));

// Presentational children with their own fetching; not what this covers.
vi.mock("@/components/contacts/CompanyLogo", () => ({ CompanyLogo: () => null }));
vi.mock("@/components/contacts/CompanyLogoPicker", () => ({ CompanyLogoPicker: () => null }));
vi.mock("@/components/contacts/PhotoPrioritySelect", () => ({
  CompanyPhotoPrioritySelect: () => null,
}));

const { Route } = await import("./contacts.companies.$companyId");
const CompanyDetailPage = (Route as unknown as { component: () => React.ReactElement }).component;

/** getCompany's shape: the row, plus its domains, tags and members. */
const company = (over: Record<string, unknown> = {}) => ({
  company: { id: COMPANY, name: "Acme", notes: null, photo_priority: null },
  domains: [] as Array<{ id: string; domain: string; is_primary: boolean }>,
  tags: [] as Array<{ tag: string }>,
  members: [] as Array<{ id: string; name: string | null; email: string | null }>,
  ...over,
});

const preview = (over: Record<string, unknown> = {}) => ({
  source: { id: COMPANY, name: "Acme" },
  target: { id: "co-2", name: "Globex" },
  contactCount: 2,
  contacts: [{ id: "c1", name: "Ann", email: "ann@acme.test" }],
  domains: [{ domain: "acme.test", source: "manual", conflict: false }],
  tags: [] as Array<{ tag: string; conflict: boolean }>,
  ...over,
});

const render = () => renderWithQuery(<CompanyDetailPage />);

const dangerZone = () =>
  within(screen.getByRole("heading", { name: "Danger zone" }).closest<HTMLElement>("section")!);

/** Open the details tab, pick a merge target, and open the preview. */
async function openMergePreview(user: ReturnType<typeof renderWithQuery>["user"]) {
  await user.click(await screen.findByRole("tab", { name: /Details/i }));
  await user.click(await screen.findByRole("combobox", { name: "Merge into another company" }));
  await user.click(await screen.findByRole("option", { name: "Globex" }));
  await user.click(dangerZone().getByRole("button", { name: /Preview merge/ }));
}

beforeEach(() => {
  fns.getCompany.mockResolvedValue(company());
  fns.listCompanies.mockResolvedValue({
    companies: [
      { id: COMPANY, name: "Acme" },
      { id: "co-2", name: "Globex" },
    ],
  });
  fns.previewMergeCompanies.mockResolvedValue(preview());
  fns.mergeCompanies.mockResolvedValue(undefined);
  fns.deleteCompany.mockResolvedValue(undefined);
  fns.addCompanyDomain.mockResolvedValue({ ok: true });
});

describe("merging this company into another", () => {
  it("cannot be started without a target", async () => {
    const { user } = render();
    await user.click(await screen.findByRole("tab", { name: /Details/i }));
    expect(dangerZone().getByRole("button", { name: /Preview merge/ })).toBeDisabled();
  });

  it("offers every other company, never this one", async () => {
    // Merging a company into itself would delete it and reassign nothing.
    const { user } = render();
    await user.click(await screen.findByRole("tab", { name: /Details/i }));
    await user.click(await screen.findByRole("combobox", { name: "Merge into another company" }));

    expect(await screen.findByRole("option", { name: "Globex" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Acme" })).not.toBeInTheDocument();
  });

  it("shows what the merge would move before doing anything", async () => {
    const { user } = render();
    await openMergePreview(user);

    expect(await screen.findByText(/Contacts to reassign \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/Domains to move \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/The source company is then deleted/)).toBeInTheDocument();
    expect(fns.mergeCompanies).not.toHaveBeenCalled();
  });

  it("previews against the target the user chose", async () => {
    const { user } = render();
    await openMergePreview(user);

    await waitFor(() => expect(fns.previewMergeCompanies).toHaveBeenCalled());
    expect((fns.previewMergeCompanies.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      sourceId: COMPANY,
      targetId: "co-2",
    });
  });

  it("folds THIS company into the target and leaves for it", async () => {
    // Direction matters: this page's company is the one that stops
    // existing, so staying here would leave the user on a dead route.
    const { user } = render();
    await openMergePreview(user);
    await user.click(await screen.findByRole("button", { name: "Confirm merge" }));

    await waitFor(() => expect(fns.mergeCompanies).toHaveBeenCalled());
    expect((fns.mergeCompanies.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      sourceId: COMPANY,
      targetId: "co-2",
    });
    expect(toast.success).toHaveBeenCalledWith("Companies merged");
    expect(navigate).toHaveBeenCalledWith({
      to: "/contacts/companies/$companyId",
      params: { companyId: "co-2" },
    });
  });

  it("will not confirm while the preview is still loading", async () => {
    fns.previewMergeCompanies.mockReturnValue(new Promise(() => {}));
    const { user } = render();
    await openMergePreview(user);

    expect(await screen.findByText("Loading preview…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm merge" })).toBeDisabled();
  });

  it("will not confirm a preview that failed", async () => {
    // Confirming here would merge without the user having seen what moves.
    fns.previewMergeCompanies.mockRejectedValue(new Error("target not found"));
    const { user } = render();
    await openMergePreview(user);

    expect(await screen.findByText("target not found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm merge" })).toBeDisabled();
  });

  it("stays put and reports a failed merge", async () => {
    fns.mergeCompanies.mockRejectedValue(new Error("company has open jobs"));
    const { user } = render();
    await openMergePreview(user);
    await user.click(await screen.findByRole("button", { name: "Confirm merge" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("company has open jobs"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("cancels without merging", async () => {
    const { user } = render();
    await openMergePreview(user);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(fns.mergeCompanies).not.toHaveBeenCalled();
  });

  it("marks a domain the target already has as one that will be dropped", async () => {
    fns.previewMergeCompanies.mockResolvedValue(
      preview({ domains: [{ domain: "acme.test", conflict: true }] }),
    );
    const { user } = render();
    await openMergePreview(user);

    const badge = await screen.findByText("acme.test");
    expect(badge.closest("[title]")).toHaveAttribute(
      "title",
      "Target already has this domain — the duplicate will be dropped",
    );
  });

  it("says so when there is nothing to move", async () => {
    fns.previewMergeCompanies.mockResolvedValue(
      preview({ contactCount: 0, contacts: [], domains: [] }),
    );
    const { user } = render();
    await openMergePreview(user);

    expect(await screen.findByText("No contacts linked.")).toBeInTheDocument();
    expect(screen.getByText("No domains on source.")).toBeInTheDocument();
  });
});

describe("the domain-conflict merge", () => {
  const conflict = { companyId: "co-2", companyName: "Globex", domain: "acme.test" };

  /** Add a domain that another company already owns. */
  async function triggerConflict(user: ReturnType<typeof renderWithQuery>["user"]) {
    fns.addCompanyDomain.mockResolvedValue({ ok: false, conflict });
    await user.click(await screen.findByRole("tab", { name: /Domains/i }));
    await user.type(await screen.findByPlaceholderText("example.com"), "acme.test{Enter}");
  }

  it("surfaces the conflict from the tab the domain was added on", async () => {
    // The domain input is on the Domains tab; the dialog used to live
    // inside the Details tab's content, which Radix unmounts while
    // another tab is open. The add then did nothing visible at all — no
    // error, no explanation, the typed domain still sitting in the box.
    const { user } = render();
    await triggerConflict(user);

    expect(await screen.findByText("Domain already in use")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge companies" })).toBeInTheDocument();
  });

  it("names both companies and which way the merge goes", async () => {
    const { user } = render();
    await triggerConflict(user);

    const dialog = within(await screen.findByRole("alertdialog"));
    expect(dialog.getByText("acme.test")).toBeInTheDocument();
    expect(dialog.getAllByText("Globex").length).toBeGreaterThan(0);
    expect(dialog.getByText("Acme")).toBeInTheDocument();
  });

  it("closes without merging on cancel", async () => {
    const { user } = render();
    await triggerConflict(user);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(fns.mergeCompanies).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByText("Domain already in use")).not.toBeInTheDocument(),
    );
  });

  it("folds the OTHER company into this one, so this page stays valid", async () => {
    // The opposite direction from the danger-zone merge: the user is
    // mid-edit here, and deleting the company they are looking at to
    // resolve a domain conflict would throw that work away.
    const { user } = render();
    await triggerConflict(user);

    await user.click(await screen.findByRole("button", { name: "Merge companies" }));

    await waitFor(() => expect(fns.mergeCompanies).toHaveBeenCalled());
    expect((fns.mergeCompanies.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      sourceId: "co-2",
      targetId: COMPANY,
    });
    // …and it does NOT navigate away, unlike the danger-zone merge.
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not re-add the domain, since the merge already brought it over", async () => {
    const { user } = render();
    await triggerConflict(user);
    const addCallsBefore = fns.addCompanyDomain.mock.calls.length;

    await user.click(await screen.findByRole("button", { name: "Merge companies" }));

    await waitFor(() => expect(fns.mergeCompanies).toHaveBeenCalled());
    expect(fns.addCompanyDomain.mock.calls).toHaveLength(addCallsBefore);
  });

  it("reports a failed conflict merge", async () => {
    fns.mergeCompanies.mockRejectedValue(new Error("locked"));
    const { user } = render();
    await triggerConflict(user);
    await user.click(await screen.findByRole("button", { name: "Merge companies" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("locked"));
  });
});

describe("deleting the company", () => {
  const openDelete = async (user: ReturnType<typeof renderWithQuery>["user"]) => {
    await user.click(await screen.findByRole("tab", { name: /Details/i }));
    await user.click(dangerZone().getByRole("button", { name: /Delete/ }));
  };

  it("asks first, naming the company", async () => {
    const { user } = render();
    await openDelete(user);

    expect(await screen.findByText(/Delete “Acme”\?/)).toBeInTheDocument();
    expect(fns.deleteCompany).not.toHaveBeenCalled();
  });

  it("deletes on confirm and returns to the contacts list", async () => {
    const { user } = render();
    await openDelete(user);
    await user.click(await screen.findByRole("button", { name: /^Delete/ }));

    await waitFor(() => expect(fns.deleteCompany).toHaveBeenCalled());
    expect((fns.deleteCompany.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      id: COMPANY,
    });
    expect(toast.success).toHaveBeenCalledWith("Company deleted");
    expect(navigate).toHaveBeenCalledWith({ to: "/contacts" });
  });

  it("stays put and reports a failed delete", async () => {
    fns.deleteCompany.mockRejectedValue(new Error("company still has contacts"));
    const { user } = render();
    await openDelete(user);
    await user.click(await screen.findByRole("button", { name: /^Delete/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("company still has contacts"));
    expect(navigate).not.toHaveBeenCalledWith({ to: "/contacts" });
  });
});
