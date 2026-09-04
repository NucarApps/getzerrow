// ContactPhotoUploader — the contact avatar and its four actions.
//
// Two things here are easy to get wrong in ways nobody notices for a
// while, so they are what this file mostly pins:
//
//   * WHICH IMAGE SHOWS. Three sources compete — the personal photo, a
//     custom company photo, and a brand logo derived from a domain — and
//     `effectivePhotoPriority` decides between them. "personal_only" must
//     never fall through to a company image, because the whole point of
//     that setting is a user who does not want their contacts wearing
//     company logos.
//   * THE BUCKET IS PRIVATE. `avatarUrl` from the database only says a
//     photo EXISTS; the browser never fetches it. What renders is a
//     short-lived signed URL minted after a server-side ownership check,
//     and the signing request is keyed on the avatar so a replacement
//     does not keep showing the old picture.
//
// The rest: uploads are validated before any bytes are read, and the
// Google push distinguishes its several outcomes rather than reporting a
// generic failure — "Load failed" toasts were what prompted the concrete
// People API reason being surfaced.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithQuery, mockReactStart, makeToastSpies } from "@/lib/__fixtures__/ui";

vi.mock("@tanstack/react-start", () => mockReactStart());

const { toast, module: sonnerModule } = makeToastSpies();
vi.mock("sonner", () => sonnerModule());

const uploadContactPhoto = vi.fn();
const removeContactPhoto = vi.fn();
const getContactPhotoSignedUrl = vi.fn();
vi.mock("@/lib/contacts/photos.functions", () => ({
  uploadContactPhoto: (...a: unknown[]) => uploadContactPhoto(...a),
  removeContactPhoto: (...a: unknown[]) => removeContactPhoto(...a),
  getContactPhotoSignedUrl: (...a: unknown[]) => getContactPhotoSignedUrl(...a),
}));

const listCompanyLogoChoices = vi.fn();
vi.mock("@/lib/company-logo.functions", () => ({
  listCompanyLogoChoices: (...a: unknown[]) => listCompanyLogoChoices(...a),
}));

const resetContactToCompanyLogo = vi.fn();
vi.mock("@/lib/contacts/company-logo-cleanup.functions", () => ({
  resetContactToCompanyLogo: (...a: unknown[]) => resetContactToCompanyLogo(...a),
}));

const pushContactPhotoToGoogleNow = vi.fn();
vi.mock("@/lib/google-contacts/push-photo-now.functions", () => ({
  pushContactPhotoToGoogleNow: (...a: unknown[]) => pushContactPhotoToGoogleNow(...a),
}));

// The logo renderer reaches for remote images; what matters here is which
// domain and photo it was handed.
vi.mock("@/components/contacts/CompanyLogo", () => ({
  CompanyLogo: ({
    domain,
    photoUrl,
    provider,
  }: {
    domain: string | null;
    photoUrl?: string | null;
    provider?: number;
  }) => (
    <div
      data-testid="company-logo"
      data-domain={domain ?? ""}
      data-photo={photoUrl ?? ""}
      data-provider={provider ?? ""}
    />
  ),
}));

const { ContactPhotoUploader } = await import("./ContactPhotoUploader");

const onChanged = vi.fn();
const CONTACT = "c1";

type Props = Parameters<typeof ContactPhotoUploader>[0];

function open(over: Partial<Props> = {}) {
  return renderWithQuery(
    <ContactPhotoUploader
      contactId={CONTACT}
      avatarUrl={null}
      displayName="Ann Lee"
      onChanged={onChanged}
      {...over}
    />,
  );
}

const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;
const png = (name = "a.png", size = 10) =>
  new File([new Uint8Array(size)], name, { type: "image/png" });

/** Put a file on the input and fire change directly.
 *
 * `userEvent.upload` honours the input's `accept` attribute and silently
 * drops anything outside it — which is the browser's first line of
 * defence, not the component's. The component re-checks because `accept`
 * is bypassable (drag-and-drop, or picking "All files"), and it is that
 * second check this exercises. */
function pick(file: File) {
  fireEvent.change(fileInput(), { target: { files: [file] } });
}

beforeEach(() => {
  listCompanyLogoChoices.mockResolvedValue([]);
  getContactPhotoSignedUrl.mockResolvedValue({ url: "https://signed.test/a.png" });
  uploadContactPhoto.mockResolvedValue(undefined);
  removeContactPhoto.mockResolvedValue(undefined);
  resetContactToCompanyLogo.mockResolvedValue(undefined);
  pushContactPhotoToGoogleNow.mockResolvedValue({ errors: [], accountsQueued: 1 });
});

describe("what the avatar shows", () => {
  it("falls back to the initial when there is nothing else", () => {
    open();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(getContactPhotoSignedUrl).not.toHaveBeenCalled();
  });

  it("signs the private object rather than using the stored URL", async () => {
    // The bucket is private: the stored URL only says a photo exists.
    open({ avatarUrl: "https://storage.test/contact-photos/u/c1-abc.png" });

    const img = await screen.findByRole("img", { name: "Ann Lee" });
    expect(img).toHaveAttribute("src", "https://signed.test/a.png");
    expect(getContactPhotoSignedUrl).toHaveBeenCalledWith({ data: { contactId: CONTACT } });
  });

  it("re-signs when the avatar changes, so a replacement is not stale", async () => {
    const { rerender } = open({ avatarUrl: "https://storage.test/contact-photos/u/old.png" });
    await screen.findByRole("img", { name: "Ann Lee" });

    getContactPhotoSignedUrl.mockResolvedValue({ url: "https://signed.test/new.png" });
    rerender(
      <ContactPhotoUploader
        contactId={CONTACT}
        avatarUrl="https://storage.test/contact-photos/u/new.png"
        displayName="Ann Lee"
        onChanged={onChanged}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Ann Lee" })).toHaveAttribute(
        "src",
        "https://signed.test/new.png",
      ),
    );
  });

  it("does not sign a stored company-logo snapshot", async () => {
    // It is not a personal photo, so there is nothing private to mint.
    open({ avatarUrl: "https://storage.test/x.png", avatarIsCompanyLogoSnapshot: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(getContactPhotoSignedUrl).not.toHaveBeenCalled();
  });

  it("prefers the company image under company_first, even with a personal photo", async () => {
    open({
      avatarUrl: "https://storage.test/x.png",
      companyDomain: "acme.test",
      effectivePhotoPriority: "company_first",
    });
    expect(await screen.findByTestId("company-logo")).toHaveAttribute("data-domain", "acme.test");
    expect(screen.queryByRole("img", { name: "Ann Lee" })).not.toBeInTheDocument();
  });

  it("prefers the personal photo under personal_first, company fills in", async () => {
    const { unmount } = open({
      avatarUrl: "https://storage.test/x.png",
      companyDomain: "acme.test",
      effectivePhotoPriority: "personal_first",
    });
    expect(await screen.findByRole("img", { name: "Ann Lee" })).toBeInTheDocument();
    unmount();

    open({ avatarUrl: null, companyDomain: "acme.test", effectivePhotoPriority: "personal_first" });
    expect(await screen.findByTestId("company-logo")).toBeInTheDocument();
  });

  it("never shows a company image under personal_only", async () => {
    // The whole point of the setting is a user who does not want their
    // contacts wearing company logos.
    open({
      avatarUrl: null,
      companyDomain: "acme.test",
      companyPhotoUrl: "https://storage.test/logo.png",
      effectivePhotoPriority: "personal_only",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("company-logo")).not.toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("lets the linked company's domain win over the email heuristic", async () => {
    // A contact at nissanusa.com whose personal address is @gmail.com
    // should still wear the company's chosen logo domain.
    open({
      companyDomain: " nissanusa.com ",
      email: "ann@gmail.test",
      effectivePhotoPriority: "company_first",
    });
    expect(await screen.findByTestId("company-logo")).toHaveAttribute(
      "data-domain",
      "nissanusa.com",
    );
  });

  it("derives a domain from the email when the company has none", async () => {
    open({ email: "ann@acme.test", effectivePhotoPriority: "company_first" });
    expect(await screen.findByTestId("company-logo")).toHaveAttribute("data-domain", "acme.test");
  });

  it("passes the user's chosen logo provider through", async () => {
    listCompanyLogoChoices.mockResolvedValue([
      { domain: "acme.test", provider: 3, source_domain: null },
    ]);
    open({ companyDomain: "acme.test", effectivePhotoPriority: "company_first" });

    await waitFor(() =>
      expect(screen.getByTestId("company-logo")).toHaveAttribute("data-provider", "3"),
    );
  });

  it("matches a pick made against the source domain, not just the domain", async () => {
    listCompanyLogoChoices.mockResolvedValue([
      { domain: "nissan.test", provider: 2, source_domain: "acme.test" },
    ]);
    open({ companyDomain: "acme.test", effectivePhotoPriority: "company_first" });

    await waitFor(() =>
      expect(screen.getByTestId("company-logo")).toHaveAttribute("data-provider", "2"),
    );
  });

  it("shows a custom company photo with no domain at all", async () => {
    open({
      companyPhotoUrl: "https://storage.test/company-logos/u/co-1.png",
      effectivePhotoPriority: "company_first",
    });
    const logo = await screen.findByTestId("company-logo");
    expect(logo).toHaveAttribute("data-photo", "https://storage.test/company-logos/u/co-1.png");
  });
});

describe("uploading", () => {
  it("rejects a file type Gmail cannot store, before reading it", async () => {
    open();
    pick(new File(["x"], "a.bmp", { type: "image/bmp" }));

    expect(toast.error).toHaveBeenCalledWith("Use JPG, PNG, GIF or WebP");
    expect(uploadContactPhoto).not.toHaveBeenCalled();
  });

  it("rejects a file over 5 MB", async () => {
    open();
    pick(png("big.png", 5 * 1024 * 1024 + 1));

    expect(toast.error).toHaveBeenCalledWith("Image too large (max 5 MB)");
    expect(uploadContactPhoto).not.toHaveBeenCalled();
  });

  it("sends the bytes base64-encoded with their real mime", async () => {
    open();
    pick(new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));

    await waitFor(() => expect(uploadContactPhoto).toHaveBeenCalled());
    expect((uploadContactPhoto.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      contactId: CONTACT,
      base64: btoa(String.fromCharCode(1, 2, 3)),
      mime: "image/png",
    });
    expect(toast.success).toHaveBeenCalledWith("Photo updated");
    expect(onChanged).toHaveBeenCalled();
  });

  it("clears the input so the same file can be picked twice", async () => {
    open();
    pick(png());
    await waitFor(() => expect(uploadContactPhoto).toHaveBeenCalled());
    expect(fileInput().value).toBe("");
  });

  it("reports a failed upload", async () => {
    uploadContactPhoto.mockRejectedValue(new Error("Photo too large"));
    open();
    pick(png());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Photo too large"));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("falls back to a generic message for a non-Error rejection", async () => {
    uploadContactPhoto.mockRejectedValue("boom");
    open();
    pick(png());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Upload failed"));
  });
});

describe("the other actions", () => {
  const withPhoto = { avatarUrl: "https://storage.test/x.png" };

  it("offers Remove only for a real personal photo", async () => {
    const { unmount } = open();
    expect(screen.queryByRole("button", { name: "Remove photo" })).not.toBeInTheDocument();
    unmount();

    open({ ...withPhoto, avatarIsCompanyLogoSnapshot: true });
    // A snapshot of a company logo is not the user's photo to remove.
    expect(screen.queryByRole("button", { name: "Remove photo" })).not.toBeInTheDocument();
  });

  it("removes the photo", async () => {
    const { user } = open(withPhoto);
    await user.click(screen.getByRole("button", { name: "Remove photo" }));

    await waitFor(() => expect(removeContactPhoto).toHaveBeenCalled());
    expect((removeContactPhoto.mock.calls[0]![0] as { data: unknown }).data).toEqual({
      contactId: CONTACT,
    });
    expect(toast.success).toHaveBeenCalledWith("Photo removed");
  });

  it("offers Reset to company logo only when there is a company to reset to", () => {
    const { unmount } = open(withPhoto);
    expect(screen.queryByRole("button", { name: "Reset to company logo" })).not.toBeInTheDocument();
    unmount();

    open({ ...withPhoto, companyId: "co-1" });
    expect(screen.getByRole("button", { name: "Reset to company logo" })).toBeInTheDocument();
  });

  it("resets to the company logo", async () => {
    const { user } = open({ ...withPhoto, companyId: "co-1" });
    await user.click(screen.getByRole("button", { name: "Reset to company logo" }));

    await waitFor(() => expect(resetContactToCompanyLogo).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("Reset to company logo");
  });

  it("reports a failed reset", async () => {
    resetContactToCompanyLogo.mockRejectedValue(new Error("no company"));
    const { user } = open({ ...withPhoto, companyId: "co-1" });
    await user.click(screen.getByRole("button", { name: "Reset to company logo" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("no company"));
  });
});

describe("pushing to Google", () => {
  const push = async (user: ReturnType<typeof renderWithQuery>["user"]) =>
    user.click(screen.getByRole("button", { name: "Sync photo to Google now" }));

  it("reports a queued push", async () => {
    const { user } = open();
    await push(user);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Sync started — photo will land in Google shortly",
      ),
    );
  });

  it("says what to do when there is no photo to send", async () => {
    pushContactPhotoToGoogleNow.mockResolvedValue({
      errors: ["no_photo_on_contact"],
      accountsQueued: 0,
    });
    const { user } = open();
    await push(user);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "No photo to sync — upload one first or set a company logo.",
      ),
    );
  });

  it("says what to do when the contact is not linked to Google", async () => {
    pushContactPhotoToGoogleNow.mockResolvedValue({
      errors: ["not_linked_to_google"],
      accountsQueued: 0,
    });
    const { user } = open();
    await push(user);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "This contact isn't linked to Google yet — sync it once first.",
      ),
    );
  });

  it("surfaces the concrete People API reason for a recent failure", async () => {
    // "Load failed" toasts were opaque; the worker retries anyway, so this
    // is diagnostic rather than an error the user must act on.
    pushContactPhotoToGoogleNow.mockResolvedValue({
      errors: [],
      accountsQueued: 1,
      recentFailures: [{ status: 400, reason: "invalidArgument", error: "photo too small" }],
    });
    const { user } = open();
    await push(user);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Sync queued, last attempt failed: Google 400 — invalidArgument — photo too small",
        { duration: 10_000 },
      ),
    );
  });

  it("omits the parts of a failure Google did not give", async () => {
    pushContactPhotoToGoogleNow.mockResolvedValue({
      errors: [],
      accountsQueued: 1,
      recentFailures: [{ status: null, reason: "quotaExceeded", error: null }],
    });
    const { user } = open();
    await push(user);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Sync queued, last attempt failed: quotaExceeded", {
        duration: 10_000,
      }),
    );
  });

  it("names a lock rather than showing the raw error code", async () => {
    pushContactPhotoToGoogleNow.mockResolvedValue({ errors: ["locked"], accountsQueued: 0 });
    const { user } = open();
    await push(user);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Sync already running"));
  });

  it("passes through an error it has no wording for", async () => {
    pushContactPhotoToGoogleNow.mockResolvedValue({
      errors: ["token_expired"],
      accountsQueued: 0,
    });
    const { user } = open();
    await push(user);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("token_expired"));
  });

  it("reports a queue with nothing to do as queued for later", async () => {
    pushContactPhotoToGoogleNow.mockResolvedValue({ errors: [], accountsQueued: 0 });
    const { user } = open();
    await push(user);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Queued for the next sync"));
  });

  it("reports a thrown push", async () => {
    pushContactPhotoToGoogleNow.mockRejectedValue(new Error("network down"));
    const { user } = open();
    await push(user);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("network down"));
  });
});
