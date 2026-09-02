// Meeting status, the past-meetings merge, and the recording-artifact
// readout, lifted out of `routes/_authenticated/meetings.tsx`.
//
// "Terminal" is the pivot the whole page turns on: it decides whether to keep
// polling Recall, whether to show the summary or the "recording in progress"
// panel, and whether to offer Stop. Getting it wrong either burns a request
// every ten seconds forever or leaves a finished meeting stuck on "Joining".

/** The statuses after which nothing more will happen on its own. */
export const TERMINAL_MEETING_STATUSES: ReadonlySet<string> = new Set(["done", "failed"]);

/** True once a meeting has finished, one way or the other. */
export function isTerminalMeetingStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL_MEETING_STATUSES.has(status);
}

/** The meetings still worth asking Recall about. */
export function pendingMeetings<T extends { status: string }>(meetings: readonly T[]): T[] {
  return meetings.filter((m) => !isTerminalMeetingStatus(m.status));
}

/**
 * How often to re-read an open meeting, in milliseconds, or `false` for "stop
 * polling" — the shape TanStack Query's `refetchInterval` takes.
 *
 * An unknown status keeps polling: a status the UI has no copy for is more
 * likely a new state we have not taught it about than a finished meeting, and
 * giving up would freeze the badge permanently.
 */
export function meetingPollIntervalMs(status: string | null | undefined): number | false {
  if (!status) return false;
  return isTerminalMeetingStatus(status) ? false : 10_000;
}

export type MeetingStatusBadge = { label: string; cls: string };

const STATUS_BADGES: Record<string, MeetingStatusBadge> = {
  scheduled: { label: "Scheduled", cls: "bg-muted text-muted-foreground" },
  joining: { label: "Joining", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  recording: { label: "Recording", cls: "bg-red-500/10 text-red-600 dark:text-red-400" },
  processing: { label: "Processing", cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  done: { label: "Done", cls: "bg-primary/10 text-primary" },
  failed: { label: "Failed", cls: "bg-destructive/10 text-destructive" },
};

const NEUTRAL_BADGE_CLS = "bg-muted text-muted-foreground";

/**
 * Copy and colour for the status pill.
 *
 * A status with no entry shows its own raw value in neutral styling rather
 * than nothing — a new state added server-side should read as unfamiliar, not
 * as an empty badge. The own-property check keeps an inherited key like
 * "constructor" from resolving to a function instead of a badge.
 */
export function meetingStatusBadge(status: string): MeetingStatusBadge {
  if (!Object.hasOwn(STATUS_BADGES, status)) return { label: status, cls: NEUTRAL_BADGE_CLS };
  return STATUS_BADGES[status] ?? { label: status, cls: NEUTRAL_BADGE_CLS };
}

/** A recorded meeting, or a calendar meeting that was never recorded. */
export type PastRow<M, E> =
  | { kind: "meeting"; sortKey: string; meeting: M }
  | { kind: "unrecorded"; sortKey: string; event: E };

type SortableMeeting = { scheduled_start?: string | null; created_at?: string | null };
type SortableEvent = { start?: string | null };

/**
 * The "past" list: recorded meetings interleaved with recent calendar meetings
 * that were never recorded, newest first.
 *
 * A meeting sorts by when it was scheduled, falling back to when its row was
 * created — an ad-hoc recording has no scheduled start, and without the
 * fallback every one of them would sink to the bottom of the list.
 *
 * Rows with no usable timestamp sort last: the comparison is on ISO strings,
 * and "" is below every real one. The sort is stable, so two rows sharing a
 * timestamp keep meetings ahead of unrecorded events.
 */
export function mergePastRows<M extends SortableMeeting, E extends SortableEvent>({
  meetings,
  unrecorded,
}: {
  meetings: readonly M[];
  unrecorded: readonly E[];
}): PastRow<M, E>[] {
  const rows: PastRow<M, E>[] = [
    ...meetings.map((m) => ({
      kind: "meeting" as const,
      sortKey: m.scheduled_start ?? m.created_at ?? "",
      meeting: m,
    })),
    ...unrecorded.map((e) => ({
      kind: "unrecorded" as const,
      sortKey: e.start ?? "",
      event: e,
    })),
  ];
  rows.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
  return rows;
}

/** What the refresh probe reported about a finished meeting's artifacts. */
export type RecordingDiagnostics = {
  hasRecording: boolean;
  hasTranscript: boolean;
  hasSummary: boolean;
} | null;

export type ArtifactPresence = {
  recording: boolean;
  transcript: boolean;
  summary: boolean;
};

/**
 * Whether each artifact exists, for the "Recording found · Transcript not
 * found yet · …" readout.
 *
 * Each answer is the OR of two sources: what the probe just reported, and what
 * the meeting row already holds. Either alone is wrong — the probe has not run
 * before the sheet opens, and the row lags behind a backfill the probe has
 * only just triggered.
 */
export function artifactPresence({
  diagnostics,
  recordingUrl,
  transcriptLength,
  summary,
}: {
  diagnostics: RecordingDiagnostics;
  recordingUrl: string | null | undefined;
  transcriptLength: number;
  summary: string | null | undefined;
}): ArtifactPresence {
  return {
    recording: !!(diagnostics?.hasRecording || recordingUrl),
    transcript: !!(diagnostics?.hasTranscript || transcriptLength > 0),
    summary: !!(diagnostics?.hasSummary || summary),
  };
}

/** "found" / "not found yet" for one artifact. */
export function artifactLabel(present: boolean): string {
  return present ? "found" : "not found yet";
}

/**
 * A title can only be generated from something the model can read. With
 * neither a summary nor a transcript the button is disabled and says why.
 */
export function canGenerateTitle(
  summary: string | null | undefined,
  transcriptLength: number,
): boolean {
  return !!summary || transcriptLength > 0;
}

export type TitleSaveDecision =
  /** Escape was pressed; the blur that follows must not save. */
  | { action: "cancelled" }
  /** The sheet has no meeting open. */
  | { action: "skip" }
  /** Nothing actually changed — close the editor without a round-trip. */
  | { action: "unchanged" }
  | { action: "save"; title: string };

/**
 * What committing the inline title editor should do.
 *
 * The cancelled rung comes first and is the reason this is a ladder rather
 * than a condition: Escape closes the editor, which fires a blur, which is the
 * same handler — without the flag, cancelling would save the draft it was
 * meant to discard.
 *
 * The comparison is against the trimmed draft, so adding and removing a space
 * is not a rename.
 */
export function titleSaveDecision({
  cancelled,
  hasMeeting,
  draft,
  currentTitle,
}: {
  cancelled: boolean;
  hasMeeting: boolean;
  draft: string;
  currentTitle: string | null | undefined;
}): TitleSaveDecision {
  if (cancelled) return { action: "cancelled" };
  if (!hasMeeting) return { action: "skip" };
  const next = draft.trim();
  if (next === (currentTitle ?? "")) return { action: "unchanged" };
  return { action: "save", title: next };
}
