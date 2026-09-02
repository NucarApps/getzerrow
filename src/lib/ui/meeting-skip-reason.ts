/**
 * Human copy for the `skipReason` the calendar-window listing attaches to a
 * meeting the notetaker will not record.
 *
 * The reasons themselves are produced by the ladder in
 * `meetings-autojoin.server.ts` (`resolveRecordingPlan`): no_link,
 * auto_record_off, declined, color, off, in_person, blocked — in that
 * precedence order.
 */

/** Label for each reason the UI has copy for. */
export const SKIP_REASON_LABEL: Record<string, string> = {
  no_link: "No video link",
  auto_record_off: "Auto-record off",
  declined: "Declined",
  // The user turned this event colour off under Event types & colors, which
  // hides its events from the upcoming list and never records them.
  color: "Event color turned off",
  off: "Turned off",
  in_person: "Recording in person",
  blocked: "Blocked contact",
};

/** Shown when a meeting is skipped for a reason with no copy of its own. */
export const SKIP_REASON_FALLBACK = "Not recorded";

/**
 * Readable explanation for why a meeting was skipped. Falls back to a bare
 * "Not recorded" for a null reason or one the label map does not know.
 *
 * The own-property check is load-bearing: a plain-object lookup answers
 * inherited keys too, so a reason of "toString" would otherwise yield a
 * function, sail past the `??`, and be handed to React as a child. TypeScript
 * cannot catch it — under an index signature the lookup is typed
 * `string | undefined` whatever the prototype actually holds.
 */
export function skipReasonLabel(reason: string | null | undefined): string {
  const key = reason ?? "";
  if (!Object.hasOwn(SKIP_REASON_LABEL, key)) return SKIP_REASON_FALLBACK;
  return SKIP_REASON_LABEL[key] ?? SKIP_REASON_FALLBACK;
}
