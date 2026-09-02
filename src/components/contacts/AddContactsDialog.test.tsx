// Component tests for AddContactsDialog — the manual form and the two bulk
// pickers (inbox senders, meeting people).
//
// The precedence and selection algebra live in src/lib/ui/add-contacts.ts and
// are tested there; this file covers the wiring the extraction cannot reach:
// which query each tab runs, what the footer says, and what actually reaches
// the server fns.
//
// Contracts under test:
//   * the manual form refuses to submit an unusable email, and sends blank
//     fields as null,
//   * switching tabs clears the selection so people are never carried across,
//   * select-all covers only the listed people and flips to unselect,
//   * bulk add sends the selected people with their names, from whichever
//     list is showing,
//   * the folder chips scope the sender query.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

vi.mock("@tanstack/react-start", () => ({
  useServerFn: <T,>(fn: T) => fn,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/settings">{children}</a>,
}));

const createContactManual = vi.fn();
const listFoldersForPicker = vi.fn();
const listUniqueInboxSenders = vi.fn();
const bulkCreateContactsFromEmails = vi.fn();
vi.mock("@/lib/contacts.functions", () => ({
  createContactManual: (...a: unknown[]) => createContactManual(...a),
  listFoldersForPicker: (...a: unknown[]) => listFoldersForPicker(...a),
  listUniqueInboxSenders: (...a: unknown[]) => listUniqueInboxSenders(...a),
  bulkCreateContactsFromEmails: (...a: unknown[]) => bulkCreateContactsFromEmails(...a),
}));

const listMeetingPeople = vi.fn();
vi.mock("@/lib/calendar.functions", () => ({
  listMeetingPeople: (...a: unknown[]) => listMeetingPeople(...a),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

import { AddContactsDialog } from "./AddContactsDialog";

const sender = (email: string, name: string | null, count = 3) => ({
  email,
  name,
  count,
  lastReceivedAt: "2026-02-01T00:00:00Z",
});

const onAdded = vi.fn();
const onOpenChange = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function open() {
  render(<AddContactsDialog open onOpenChange={onOpenChange} onAdded={onAdded} />, { wrapper });
}

const tab = (name: RegExp) => screen.getByRole("tab", { name });

beforeEach(() => {
  listFoldersForPicker.mockResolvedValue({ folders: [] });
  listUniqueInboxSenders.mockResolvedValue({ senders: [] });
  listMeetingPeople.mockResolvedValue({ people: [], calendarAccess: true });
  createContactManual.mockResolvedValue(undefined);
  bulkCreateContactsFromEmails.mockResolvedValue({ created: 0 });
});

describe("AddContactsDialog — manual tab", () => {
  it("every manual field is reachable by its visible label", async () => {
    // Regression: Field rendered its caption as a sibling <Label> with no
    // htmlFor, so six of these had no accessible name — a screen reader
    // announced bare edit boxes and clicking a caption focused nothing.
    open();
    for (const label of ["Email *", "Name", "Title", "Company", "Phone", "Website"]) {
      expect(screen.getByLabelText(label), `no control named "${label}"`).toBeInTheDocument();
    }
  });

  it("keeps the submit button out of reach until an email is typed", async () => {
    open();
    expect(screen.getByRole("button", { name: "Add contact" })).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Email *"), "jane@example.com");
    expect(screen.getByRole("button", { name: "Add contact" })).toBeEnabled();
  });

  it("refuses an email with no domain dot and says so instead of calling the server", async () => {
    open();
    await userEvent.type(screen.getByLabelText("Email *"), "jane@example");
    await userEvent.click(screen.getByRole("button", { name: "Add contact" }));

    expect(toastError).toHaveBeenCalledWith("Enter a valid email");
    expect(createContactManual).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("sends blank optional fields as null and closes on success", async () => {
    open();
    await userEvent.type(screen.getByLabelText("Email *"), "jane@example.com");
    await userEvent.type(screen.getByLabelText("Name"), "Jane Doe");
    await userEvent.click(screen.getByRole("button", { name: "Add contact" }));

    await waitFor(() =>
      expect(createContactManual).toHaveBeenCalledWith({
        data: {
          email: "jane@example.com",
          name: "Jane Doe",
          title: null,
          company: null,
          phone: null,
          website: null,
          linkedin: null,
          twitter: null,
        },
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Contact added");
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces the server's message and stays open when the create fails", async () => {
    createContactManual.mockRejectedValueOnce(new Error("Contact already exists"));
    open();
    await userEvent.type(screen.getByLabelText("Email *"), "jane@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Add contact" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Contact already exists"));
    expect(onAdded).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("AddContactsDialog — inbox picker", () => {
  it("does not read the inbox until its tab is opened", async () => {
    open();
    expect(listUniqueInboxSenders).not.toHaveBeenCalled();

    await userEvent.click(tab(/From inbox/));
    await waitFor(() => expect(listUniqueInboxSenders).toHaveBeenCalled());
  });

  it("asks for every folder until one is picked, then scopes to it", async () => {
    listFoldersForPicker.mockResolvedValue({
      folders: [{ id: "f1", name: "Receipts", color: "#fff" }],
    });
    open();
    await userEvent.click(tab(/From inbox/));

    await waitFor(() =>
      expect(listUniqueInboxSenders).toHaveBeenCalledWith({
        data: { folderIds: undefined, search: undefined },
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: /Receipts/ }));
    await waitFor(() =>
      expect(listUniqueInboxSenders).toHaveBeenCalledWith({
        data: { folderIds: ["f1"], search: undefined },
      }),
    );
  });

  it("says there is nothing to pick when the scope has no new senders", async () => {
    open();
    await userEvent.click(tab(/From inbox/));
    expect(await screen.findByText("No new senders found in this scope.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Select all visible/ })).toBeDisabled();
  });

  it("counts the selection in the header and on the submit button", async () => {
    listUniqueInboxSenders.mockResolvedValue({
      senders: [sender("a@x.test", "Ada"), sender("b@x.test", "Bo")],
    });
    open();
    await userEvent.click(tab(/From inbox/));

    await userEvent.click(await screen.findByRole("button", { name: /Ada/ }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add 1 contact" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /Bo/ }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add 2 contacts" })).toBeInTheDocument();
  });

  it("flips select-all to unselect once everything listed is picked", async () => {
    listUniqueInboxSenders.mockResolvedValue({
      senders: [sender("a@x.test", "Ada"), sender("b@x.test", "Bo")],
    });
    open();
    await userEvent.click(tab(/From inbox/));

    await userEvent.click(await screen.findByRole("button", { name: /Select all visible/ }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Unselect all/ }));
    expect(screen.getByText("0 selected")).toBeInTheDocument();
  });

  it("sends the picked senders with their names and closes on success", async () => {
    listUniqueInboxSenders.mockResolvedValue({
      senders: [sender("a@x.test", "Ada"), sender("b@x.test", null)],
    });
    bulkCreateContactsFromEmails.mockResolvedValueOnce({ created: 2 });
    open();
    await userEvent.click(tab(/From inbox/));

    await userEvent.click(await screen.findByRole("button", { name: /Select all visible/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add 2 contacts" }));

    await waitFor(() =>
      expect(bulkCreateContactsFromEmails).toHaveBeenCalledWith({
        data: {
          items: [
            { email: "a@x.test", name: "Ada" },
            { email: "b@x.test", name: null },
          ],
        },
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Added 2 contacts");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces the server's message when the bulk add fails", async () => {
    listUniqueInboxSenders.mockResolvedValue({ senders: [sender("a@x.test", "Ada")] });
    bulkCreateContactsFromEmails.mockRejectedValueOnce(new Error("Contact limit reached"));
    open();
    await userEvent.click(tab(/From inbox/));

    await userEvent.click(await screen.findByRole("button", { name: /Ada/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add 1 contact" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Contact limit reached"));
    expect(onAdded).not.toHaveBeenCalled();
  });
});

describe("AddContactsDialog — meetings picker", () => {
  it("reads past meetings first and switches to upcoming on request", async () => {
    open();
    await userEvent.click(tab(/From meetings/));
    await waitFor(() =>
      expect(listMeetingPeople).toHaveBeenCalledWith({
        data: { when: "past", search: undefined },
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Upcoming meetings" }));
    await waitFor(() =>
      expect(listMeetingPeople).toHaveBeenCalledWith({
        data: { when: "upcoming", search: undefined },
      }),
    );
  });

  it("points at Settings instead of an empty list when calendar access is missing", async () => {
    listMeetingPeople.mockResolvedValue({ people: [], calendarAccess: false });
    open();
    await userEvent.click(tab(/From meetings/));

    expect(await screen.findByText(/enable calendar access in/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
  });

  it("shows the meeting a person came from under their name", async () => {
    listMeetingPeople.mockResolvedValue({
      people: [
        {
          email: "a@x.test",
          name: "Ada",
          eventTitle: "Quarterly review",
          meetingAt: "2026-02-01T00:00:00Z",
        },
      ],
      calendarAccess: true,
    });
    open();
    await userEvent.click(tab(/From meetings/));

    const row = await screen.findByRole("button", { name: /Ada/ });
    expect(within(row).getByText("a@x.test · Quarterly review")).toBeInTheDocument();
  });

  it("sends the picked meeting people, not the inbox senders", async () => {
    listUniqueInboxSenders.mockResolvedValue({ senders: [sender("inbox@x.test", "Inbox Person")] });
    listMeetingPeople.mockResolvedValue({
      people: [{ email: "meet@x.test", name: "Meeting Person", eventTitle: null, meetingAt: null }],
      calendarAccess: true,
    });
    bulkCreateContactsFromEmails.mockResolvedValueOnce({ created: 1 });
    open();
    await userEvent.click(tab(/From meetings/));

    await userEvent.click(await screen.findByRole("button", { name: /Meeting Person/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add 1 contact" }));

    await waitFor(() =>
      expect(bulkCreateContactsFromEmails).toHaveBeenCalledWith({
        data: { items: [{ email: "meet@x.test", name: "Meeting Person" }] },
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Added 1 contact");
  });

  it("clears the selection when the user moves to another tab", async () => {
    listUniqueInboxSenders.mockResolvedValue({ senders: [sender("a@x.test", "Ada")] });
    listMeetingPeople.mockResolvedValue({
      people: [{ email: "m@x.test", name: "Mo", eventTitle: null, meetingAt: null }],
      calendarAccess: true,
    });
    open();

    await userEvent.click(tab(/From inbox/));
    await userEvent.click(await screen.findByRole("button", { name: /Ada/ }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await userEvent.click(tab(/From meetings/));
    expect(await screen.findByRole("button", { name: /Mo/ })).toBeInTheDocument();
    expect(screen.getByText("0 selected")).toBeInTheDocument();
    // With nothing selected the count collapses out of the label entirely.
    expect(screen.getByRole("button", { name: "Add contacts" })).toBeDisabled();
  });

  it("clears the selection when the past/upcoming scope changes", async () => {
    listMeetingPeople.mockResolvedValue({
      people: [{ email: "m@x.test", name: "Mo", eventTitle: null, meetingAt: null }],
      calendarAccess: true,
    });
    open();
    await userEvent.click(tab(/From meetings/));

    await userEvent.click(await screen.findByRole("button", { name: /Mo/ }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Upcoming meetings" }));
    expect(screen.getByText("0 selected")).toBeInTheDocument();
  });
});
