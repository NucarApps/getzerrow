// Shared server-only helpers/constants used by src/lib/meetings/*.functions.ts.
// Anything referenced from more than one split file — or from a createServerFn
// handler/inputValidator — belongs here so the `?tss-serverfn-split` transform
// never has to reach across sibling module scope for it.

/**
 * Hosts we can send the notetaker to, as a regex alternation. Single-sourced
 * because the provider list is the part that drifts when support is added —
 * every meeting-URL pattern in the codebase is built from this.
 */
export const MEETING_PROVIDER_HOSTS =
  "zoom\\.us|meet\\.google\\.com|teams\\.microsoft\\.com|teams\\.live\\.com|webex\\.com";

const MEETING_URL_RE = new RegExp(
  `^https?://(?:[a-z0-9-]+\\.)*(?:${MEETING_PROVIDER_HOSTS})/`,
  "i",
);

// Same pattern, but matches anywhere within a longer string (invite emails,
// calendar blurbs) so we can pull the join link out of pasted text.
const MEETING_URL_SCAN_RE = new RegExp(
  `https?://(?:[a-z0-9-]+\\.)*(?:${MEETING_PROVIDER_HOSTS})/[^\\s<>"')]*`,
  "i",
);

/**
 * Pull the first supported meeting URL out of any pasted text. Returns the
 * clean link, or null when no supported link is present.
 */
export function extractMeetingUrl(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (MEETING_URL_RE.test(trimmed)) return trimmed;
  const match = trimmed.match(MEETING_URL_SCAN_RE);
  return match ? match[0] : null;
}

export const NO_LINK_MESSAGE =
  "We couldn't find a supported meeting link. Paste a Zoom, Google Meet, or Microsoft Teams link.";

// A blocklist entry is either a full email (jane@lawfirm.com) or a bare
// domain (lawfirm.com) to skip everyone at a firm.
export { EMAIL_RE } from "./contacts/email-address";
export const DOMAIN_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;

export const DEFAULT_CHAT_MESSAGE =
  "Hi! I'm the Zerrow notetaker. I'm here to record and summarize this meeting.";

// Google's five special event categories. "default" (a normal meeting) is
// always shown/recordable and never appears in this list.
export const SPECIAL_EVENT_TYPES = [
  "outOfOffice",
  "workingLocation",
  "focusTime",
  "birthday",
] as const;
export const DEFAULT_HIDDEN_TYPES = [...SPECIAL_EVENT_TYPES];
// Google Calendar's 11 event color IDs.
export const EVENT_COLOR_IDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"] as const;
