// Render tests for UpcomingMeetingsCard — the "what happens to each upcoming
// meeting" list in settings.
//
// This closes the loop on the server-side recording ladder: the server decides
// hasMeetingLink / blocked / recordMode / excluded / canResendBot, and this is
// the only place a user ever sees those decisions. Each contract below is one
// server flag reaching one visible affordance.
//
// Contracts under test:
//   * the capture mode shown is recordMode, with excluded as the legacy
//     fallback for a row that predates it,
//   * a meeting with no video link offers no control at all, only the reason,
//   * a blocked guest suppresses the control and explains itself,
//   * canResendBot surfaces both the warning and the resend button, and the
//     button only appears when there is a meeting row to resend against,
//   * the calendar-access, empty and reconnect states each render their own copy.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

vi.mock("@tanstack/react-start", () => ({
  useServerFn: <T,>(fn: T) => fn,
}));

const listAllUpcomingCalendarEvents = vi.fn();
const setEventRecordingMode = vi.fn();
const resendMeetingBot = vi.fn();
vi.mock("@/lib/meetings.functions", () => ({
  listAllUpcomingCalendarEvents: (...a: unknown[]) => listAllUpcomingCalendarEvents(...a),
  setEventRecordingMode: (...a: unknown[]) => setEventRecordingMode(...a),
  resendMeetingBot: (...a: unknown[]) => resendMeetingBot(...a),
}));

const startGoogleReconnect = vi.fn();
vi.mock("@/hooks/use-google-reconnect", () => ({
  useGoogleReconnect: () => startGoogleReconnect,
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

import { UpcomingMeetingsCard } from "./UpcomingMeetingsCard";

type Event = {
  id: string;
  accountId: string;
  accountEmail: string | null;
  title: string | null;
  start: string | null;
  hasMeetingLink: boolean;
  scheduled: boolean;
  excluded: boolean;
  recordMode: "bot" | "in_person" | "off" | null;
  blocked: boolean;
  blockedBy: string | null;
  declined: boolean;
  meetingId: string | null;
  meetingStatus: string | null;
  hasRecording: boolean;
  canResendBot: boolean;
};

const event = (over: Partial<Event> = {}): Event => ({
  id: "evt-1",
  accountId: "acct-1",
  accountEmail: "a@acme.com",
  title: "Quarterly review",
  start: "2026-03-01T15:00:00Z",
  hasMeetingLink: true,
  scheduled: false,
  excluded: false,
  recordMode: "bot",
  blocked: false,
  blockedBy: null,
  declined: false,
  meetingId: null,
  meetingStatus: null,
  hasRecording: false,
  canResendBot: false,
  ...over,
});

function listing(over: { events?: Event[]; calendarAccess?: boolean } = {}) {
  return {
    calendarAccess: over.calendarAccess ?? true,
    events: over.events ?? [],
    accountsNeedingReconnect: [] as { id: string; email: string | null }[],
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const onRecordInPerson = vi.fn();

async function renderCard(data: ReturnType<typeof listing>) {
  listAllUpcomingCalendarEvents.mockResolvedValue(data);
  render(<UpcomingMeetingsCard onRecordInPerson={onRecordInPerson} />, { wrapper });
  await waitFor(() => expect(listAllUpcomingCalendarEvents).toHaveBeenCalled());
}

/** The capture control for one meeting, found by its accessible label. */
const modeControl = (title: string) =>
  screen.findByRole("combobox", { name: `How to capture ${title}` });

beforeEach(() => {
  startGoogleReconnect.mockResolvedValue(true);
  setEventRecordingMode.mockResolvedValue(undefined);
  resendMeetingBot.mockResolvedValue(undefined);
});

describe("UpcomingMeetingsCard", () => {
  it("explains that calendar access has not been granted", async () => {
    await renderCard(listing({ calendarAccess: false }));
    await screen.findByText(/Calendar access hasn't been granted yet/);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("says the calendar is empty when there is nothing in the window", async () => {
    await renderCard(listing({ events: [] }));
    expect(
      await screen.findByText("No meetings on your calendar in the next 14 days."),
    ).toBeInTheDocument();
  });

  it("defaults a meeting with no explicit mode to sending the notetaker", async () => {
    await renderCard(listing({ events: [event({ recordMode: null, excluded: false })] }));
    expect(await screen.findByText("Quarterly review")).toBeInTheDocument();
    expect(await modeControl("Quarterly review")).toHaveTextContent("Send notetaker");
  });

  it("reads a legacy excluded row as 'don't record' when it has no recordMode", async () => {
    await renderCard(listing({ events: [event({ recordMode: null, excluded: true })] }));
    expect(await modeControl("Quarterly review")).toHaveTextContent("Don't record");
  });

  it("prefers an explicit recordMode over the legacy excluded flag", async () => {
    await renderCard(listing({ events: [event({ recordMode: "bot", excluded: true })] }));
    expect(await modeControl("Quarterly review")).toHaveTextContent("Send notetaker");
  });

  it("notes when the notetaker is already booked for a meeting", async () => {
    await renderCard(listing({ events: [event({ recordMode: "bot", scheduled: true })] }));
    expect(await screen.findByText(/Notetaker scheduled/)).toBeInTheDocument();
  });

  it("offers no control at all for a meeting with no video link", async () => {
    await renderCard(listing({ events: [event({ hasMeetingLink: false })] }));
    await screen.findByText("No video link — the notetaker can't join");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("marks a meeting with a blocked guest and withdraws the control", async () => {
    await renderCard(listing({ events: [event({ blocked: true, blockedBy: "legal@acme.com" })] }));
    await screen.findByText("Guest on your don't-record list — won't be recorded.");
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("offers the in-person recorder only for a meeting set to record in person", async () => {
    await renderCard(listing({ events: [event({ recordMode: "in_person" })] }));
    await screen.findByText("You'll record this one in person");
    expect(screen.getByRole("button", { name: /Record now/ })).toBeInTheDocument();
  });

  it("hands the in-person recorder everything it needs to link the recording back", async () => {
    await renderCard(
      listing({
        events: [event({ recordMode: "in_person", title: "Design sync", id: "evt-9" })],
      }),
    );
    await userEvent.click(await screen.findByRole("button", { name: /Record now/ }));
    expect(onRecordInPerson).toHaveBeenCalledWith({
      title: "Design sync",
      calendarEventId: "evt-9",
      accountId: "acct-1",
      scheduledStart: "2026-03-01T15:00:00Z",
    });
  });

  it("does not offer the in-person recorder for a meeting sending the notetaker", async () => {
    await renderCard(listing({ events: [event({ recordMode: "bot" })] }));
    expect(await modeControl("Quarterly review")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Record now/ })).not.toBeInTheDocument();
  });

  it("warns and offers a retry when the notetaker failed to join", async () => {
    await renderCard(listing({ events: [event({ canResendBot: true, meetingId: "meeting-1" })] }));
    await screen.findByText("Notetaker didn't join — try again.");
    expect(screen.getByRole("button", { name: /Resend notetaker/ })).toBeInTheDocument();
  });

  it("resends against the linked meeting row, not the calendar event", async () => {
    await renderCard(
      listing({ events: [event({ canResendBot: true, meetingId: "meeting-1", id: "evt-9" })] }),
    );
    await userEvent.click(await screen.findByRole("button", { name: /Resend notetaker/ }));
    expect(resendMeetingBot).toHaveBeenCalledWith({ data: { id: "meeting-1" } });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Notetaker on its way"));
  });

  it("surfaces the server's message when a resend fails", async () => {
    resendMeetingBot.mockRejectedValueOnce(new Error("Meeting already started"));
    await renderCard(listing({ events: [event({ canResendBot: true, meetingId: "meeting-1" })] }));
    await userEvent.click(await screen.findByRole("button", { name: /Resend notetaker/ }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Meeting already started"));
  });

  it("warns without a retry button when there is no meeting row to resend against", async () => {
    await renderCard(listing({ events: [event({ canResendBot: true, meetingId: null })] }));
    await screen.findByText("Notetaker didn't join — try again.");
    expect(screen.queryByRole("button", { name: /Resend notetaker/ })).not.toBeInTheDocument();
  });

  it("never offers a retry for a meeting the server did not mark resendable", async () => {
    await renderCard(listing({ events: [event({ canResendBot: false, meetingId: "meeting-1" })] }));
    expect(await modeControl("Quarterly review")).toBeInTheDocument();
    expect(screen.queryByText("Notetaker didn't join — try again.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Resend notetaker/ })).not.toBeInTheDocument();
  });

  it("shows which inbox a meeting came from only when more than one is connected", async () => {
    await renderCard(listing({ events: [event({ accountEmail: "solo@acme.com" })] }));
    expect(await screen.findByText("Quarterly review")).toBeInTheDocument();
    expect(screen.queryByText(/solo@acme.com/)).not.toBeInTheDocument();
  });

  it("labels each meeting with its inbox when two are connected", async () => {
    await renderCard(
      listing({
        events: [
          event({ id: "e1", accountId: "acct-1", accountEmail: "a@acme.com", title: "One" }),
          event({ id: "e2", accountId: "acct-2", accountEmail: "b@acme.com", title: "Two" }),
        ],
      }),
    );
    expect(await screen.findByText(/a@acme\.com/)).toBeInTheDocument();
    expect(screen.getByText(/b@acme\.com/)).toBeInTheDocument();
  });

  it("names an untitled meeting rather than rendering a blank row", async () => {
    await renderCard(listing({ events: [event({ title: null })] }));
    expect(await screen.findByText("Untitled meeting")).toBeInTheDocument();
    expect(await modeControl("this meeting")).toBeInTheDocument();
  });

  it("says when a meeting has no start time instead of printing a dash", async () => {
    await renderCard(listing({ events: [event({ start: null })] }));
    expect(await screen.findByText(/No start time/)).toBeInTheDocument();
  });

  it("offers a per-inbox reconnect when the calendar cannot be read", async () => {
    const data = listing({ events: [] });
    data.accountsNeedingReconnect = [{ id: "acct-3", email: "stale@acme.com" }];
    await renderCard(data);

    await screen.findByText("An inbox needs reconnecting");
    const button = screen.getByRole("button", { name: /Reconnect stale@acme\.com/ });
    await userEvent.click(button);
    expect(startGoogleReconnect).toHaveBeenCalledWith({ loginHint: "stale@acme.com" });
  });

  it("switches to the plural warning when several inboxes are stale", async () => {
    const data = listing({ events: [] });
    data.accountsNeedingReconnect = [
      { id: "acct-3", email: "one@acme.com" },
      { id: "acct-4", email: null },
    ];
    await renderCard(data);

    await screen.findByText("Some inboxes need reconnecting");
    expect(screen.getByRole("button", { name: /Reconnect inbox/ })).toBeInTheDocument();
  });

  it("suppresses the empty-calendar copy while a reconnect is outstanding", async () => {
    const data = listing({ events: [] });
    data.accountsNeedingReconnect = [{ id: "acct-3", email: "stale@acme.com" }];
    await renderCard(data);

    await screen.findByText("An inbox needs reconnecting");
    expect(
      screen.queryByText("No meetings on your calendar in the next 14 days."),
    ).not.toBeInTheDocument();
  });

  it("writes the chosen capture mode back for that meeting and inbox", async () => {
    await renderCard(listing({ events: [event({ recordMode: "bot", id: "evt-9" })] }));
    await userEvent.click(await modeControl("Quarterly review"));
    await userEvent.click(await screen.findByRole("option", { name: "Don't record" }));

    await waitFor(() =>
      expect(setEventRecordingMode).toHaveBeenCalledWith({
        data: { accountId: "acct-1", calendarEventId: "evt-9", mode: "off" },
      }),
    );
  });

  it("rolls the row back and warns when the write fails", async () => {
    setEventRecordingMode.mockRejectedValueOnce(new Error("nope"));
    await renderCard(listing({ events: [event({ recordMode: "bot" })] }));
    await userEvent.click(await modeControl("Quarterly review"));
    await userEvent.click(await screen.findByRole("option", { name: "Don't record" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't update that event."));
    await waitFor(async () =>
      expect(await modeControl("Quarterly review")).toHaveTextContent("Send notetaker"),
    );
  });
});
