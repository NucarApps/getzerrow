import { describe, expect, it } from "vitest";
import {
  artifactLabel,
  artifactPresence,
  canGenerateTitle,
  isTerminalMeetingStatus,
  meetingPollIntervalMs,
  meetingStatusBadge,
  mergePastRows,
  pendingMeetings,
  titleSaveDecision,
} from "./meeting-status";

describe("isTerminalMeetingStatus", () => {
  it.each([
    ["done", true],
    ["failed", true],
    ["scheduled", false],
    ["joining", false],
    ["recording", false],
    ["processing", false],
  ])("answers %s for %s", (status, expected) => {
    expect(isTerminalMeetingStatus(status)).toBe(expected);
  });

  it.each([
    ["a missing status", undefined],
    ["a null status", null],
    ["an empty status", ""],
    ["a status nobody has taught it", "uploading"],
  ])("does not call %s terminal", (_label, status) => {
    expect(isTerminalMeetingStatus(status)).toBe(false);
  });
});

describe("pendingMeetings", () => {
  const meetings = [
    { id: "m1", status: "recording" },
    { id: "m2", status: "done" },
    { id: "m3", status: "failed" },
    { id: "m4", status: "scheduled" },
  ];

  it("keeps only the meetings still worth asking about", () => {
    expect(pendingMeetings(meetings).map((m) => m.id)).toStrictEqual(["m1", "m4"]);
  });

  it("returns nothing when everything has finished", () => {
    expect(pendingMeetings([{ id: "m2", status: "done" }])).toStrictEqual([]);
  });

  it("returns nothing for an empty list", () => {
    expect(pendingMeetings([])).toStrictEqual([]);
  });
});

describe("meetingPollIntervalMs", () => {
  it.each(["scheduled", "joining", "recording", "processing"])("keeps polling while %s", (s) => {
    expect(meetingPollIntervalMs(s)).toBe(10_000);
  });

  it.each(["done", "failed"])("stops polling once %s", (s) => {
    expect(meetingPollIntervalMs(s)).toBe(false);
  });

  it("keeps polling an unrecognised status", () => {
    // A state added server-side that the UI has no copy for is more likely new
    // than finished; giving up would freeze the badge permanently.
    expect(meetingPollIntervalMs("uploading")).toBe(10_000);
  });

  it("does not poll before the meeting has loaded", () => {
    expect(meetingPollIntervalMs(undefined)).toBe(false);
    expect(meetingPollIntervalMs(null)).toBe(false);
  });
});

describe("meetingStatusBadge", () => {
  it.each([
    ["scheduled", "Scheduled"],
    ["joining", "Joining"],
    ["recording", "Recording"],
    ["processing", "Processing"],
    ["done", "Done"],
    ["failed", "Failed"],
  ])("labels %s as %s", (status, label) => {
    expect(meetingStatusBadge(status).label).toBe(label);
  });

  it("gives the failure its own destructive styling", () => {
    expect(meetingStatusBadge("failed").cls).toBe("bg-destructive/10 text-destructive");
  });

  it("shows an unfamiliar status verbatim in neutral styling", () => {
    expect(meetingStatusBadge("uploading")).toStrictEqual({
      label: "uploading",
      cls: "bg-muted text-muted-foreground",
    });
  });

  it.each(["toString", "constructor", "__proto__"])(
    "does not let the inherited key %s resolve to a badge",
    (status) => {
      expect(meetingStatusBadge(status)).toStrictEqual({
        label: status,
        cls: "bg-muted text-muted-foreground",
      });
    },
  );
});

describe("mergePastRows", () => {
  const jan = "2026-01-10T09:00:00Z";
  const feb = "2026-02-10T09:00:00Z";
  const mar = "2026-03-10T09:00:00Z";

  it("interleaves recorded and unrecorded meetings newest first", () => {
    const rows = mergePastRows({
      meetings: [
        { id: "m-jan", scheduled_start: jan, created_at: null },
        { id: "m-mar", scheduled_start: mar, created_at: null },
      ],
      unrecorded: [{ id: "e-feb", start: feb }],
    });
    expect(rows.map((r) => (r.kind === "meeting" ? r.meeting.id : r.event.id))).toStrictEqual([
      "m-mar",
      "e-feb",
      "m-jan",
    ]);
  });

  it("tags each row with where it came from", () => {
    const rows = mergePastRows({
      meetings: [{ id: "m1", scheduled_start: mar, created_at: null }],
      unrecorded: [{ id: "e1", start: feb }],
    });
    expect(rows.map((r) => r.kind)).toStrictEqual(["meeting", "unrecorded"]);
  });

  it("falls back to created_at for an ad-hoc recording with no scheduled start", () => {
    // Without the fallback every ad-hoc recording would sort to the bottom.
    const rows = mergePastRows({
      meetings: [
        { id: "adhoc", scheduled_start: null, created_at: mar },
        { id: "scheduled", scheduled_start: feb, created_at: jan },
      ],
      unrecorded: [],
    });
    expect(rows.map((r) => r.sortKey)).toStrictEqual([mar, feb]);
  });

  it("sinks rows with no usable timestamp to the bottom", () => {
    const rows = mergePastRows({
      meetings: [{ id: "undated", scheduled_start: null, created_at: null }],
      unrecorded: [{ id: "e1", start: feb }],
    });
    expect(rows.map((r) => (r.kind === "meeting" ? r.meeting.id : r.event.id))).toStrictEqual([
      "e1",
      "undated",
    ]);
  });

  it("keeps a recorded meeting ahead of an unrecorded event at the same instant", () => {
    // The sort is stable and meetings are laid down first, so the recorded row
    // — the one with something to open — stays on top.
    const rows = mergePastRows({
      meetings: [{ id: "m1", scheduled_start: feb, created_at: null }],
      unrecorded: [{ id: "e1", start: feb }],
    });
    expect(rows.map((r) => r.kind)).toStrictEqual(["meeting", "unrecorded"]);
  });

  it("handles either side being empty", () => {
    expect(mergePastRows({ meetings: [], unrecorded: [{ id: "e1", start: feb }] })).toHaveLength(1);
    expect(
      mergePastRows({ meetings: [{ id: "m1", scheduled_start: feb }], unrecorded: [] }),
    ).toHaveLength(1);
    expect(mergePastRows({ meetings: [], unrecorded: [] })).toStrictEqual([]);
  });
});

describe("artifactPresence", () => {
  const none = { hasRecording: false, hasTranscript: false, hasSummary: false };

  it("believes the probe when it reports everything present", () => {
    expect(
      artifactPresence({
        diagnostics: { hasRecording: true, hasTranscript: true, hasSummary: true },
        recordingUrl: null,
        transcriptLength: 0,
        summary: null,
      }),
    ).toStrictEqual({ recording: true, transcript: true, summary: true });
  });

  it("believes the meeting row when the probe has not run yet", () => {
    // The sheet paints before the probe returns; reporting "not found yet" for
    // artifacts already on the row would read as data loss.
    expect(
      artifactPresence({
        diagnostics: null,
        recordingUrl: "https://rec.test/a.mp4",
        transcriptLength: 12,
        summary: "We agreed to ship Friday.",
      }),
    ).toStrictEqual({ recording: true, transcript: true, summary: true });
  });

  it("believes the probe over a row that has not caught up with the backfill", () => {
    expect(
      artifactPresence({
        diagnostics: { hasRecording: false, hasTranscript: true, hasSummary: false },
        recordingUrl: null,
        transcriptLength: 0,
        summary: null,
      }),
    ).toStrictEqual({ recording: false, transcript: true, summary: false });
  });

  it("reports nothing found when neither source has anything", () => {
    expect(
      artifactPresence({
        diagnostics: none,
        recordingUrl: null,
        transcriptLength: 0,
        summary: null,
      }),
    ).toStrictEqual({ recording: false, transcript: false, summary: false });
  });

  it("does not count an empty transcript or an empty summary string", () => {
    expect(
      artifactPresence({
        diagnostics: none,
        recordingUrl: "",
        transcriptLength: 0,
        summary: "",
      }),
    ).toStrictEqual({ recording: false, transcript: false, summary: false });
  });
});

describe("artifactLabel", () => {
  it.each([
    [true, "found"],
    [false, "not found yet"],
  ])("renders %s as %s", (present, expected) => {
    expect(artifactLabel(present)).toBe(expected);
  });
});

describe("canGenerateTitle", () => {
  it.each([
    ["a summary alone", "We agreed to ship Friday.", 0, true],
    ["a transcript alone", null, 4, true],
    ["both", "Summary", 4, true],
    ["neither", null, 0, false],
    ["an empty summary and no transcript", "", 0, false],
  ])("allows generation with %s: %s", (_label, summary, transcriptLength, expected) => {
    expect(canGenerateTitle(summary, transcriptLength)).toBe(expected);
  });
});

describe("titleSaveDecision", () => {
  function decide(over: Partial<Parameters<typeof titleSaveDecision>[0]> = {}) {
    return titleSaveDecision({
      cancelled: false,
      hasMeeting: true,
      draft: "Quarterly review",
      currentTitle: "Untitled",
      ...over,
    });
  }

  it("saves the trimmed draft", () => {
    expect(decide({ draft: "  Quarterly review  " })).toStrictEqual({
      action: "save",
      title: "Quarterly review",
    });
  });

  it("discards the draft after Escape, before anything else is judged", () => {
    // Escape closes the editor, which fires the blur that runs this same
    // handler — without the flag, cancelling would save what it meant to drop.
    expect(decide({ cancelled: true, draft: "Something typed" })).toStrictEqual({
      action: "cancelled",
    });
  });

  it("does nothing with no meeting open", () => {
    expect(decide({ hasMeeting: false })).toStrictEqual({ action: "skip" });
  });

  it("skips the round-trip when the title did not change", () => {
    expect(decide({ draft: "Untitled", currentTitle: "Untitled" })).toStrictEqual({
      action: "unchanged",
    });
  });

  it("treats added-then-removed whitespace as no change", () => {
    expect(decide({ draft: " Untitled ", currentTitle: "Untitled" })).toStrictEqual({
      action: "unchanged",
    });
  });

  it("saves a title cleared to empty against an existing one", () => {
    expect(decide({ draft: "   ", currentTitle: "Untitled" })).toStrictEqual({
      action: "save",
      title: "",
    });
  });

  it("treats an empty draft on a meeting with no title as no change", () => {
    expect(decide({ draft: "", currentTitle: null })).toStrictEqual({ action: "unchanged" });
  });
});
