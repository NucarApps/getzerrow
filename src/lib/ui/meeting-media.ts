/**
 * Browser-side meeting helpers pulled out of the meetings route: recognising
 * a conferencing platform from a URL, and choosing a container the running
 * browser's `MediaRecorder` will actually accept.
 *
 * Both are pure (`pickMime` reads only the `MediaRecorder` global), and
 * `pickMime` in particular guards the Safari/iOS recorder path — Safari
 * supports none of the WebM candidates, so the fallback it returns decides
 * whether a recording is transcribable at all.
 */

/** Platform slug used by the client, keyed by {@link PLATFORM_LABEL}. */
export type MeetingPlatform = "zoom" | "google_meet" | "teams" | "webex";

/** Human label for each platform slug the client recognises. */
export const PLATFORM_LABEL: Record<MeetingPlatform, string> = {
  zoom: "Zoom",
  google_meet: "Google Meet",
  teams: "Microsoft Teams",
  webex: "Webex",
};

/**
 * Coarse platform slug for a meeting URL, or null when the host matches none
 * of the four the app knows about.
 *
 * Matching is on the host substring anywhere in the URL and is
 * case-insensitive, so a link in a calendar description ("Join at
 * HTTPS://ACME.ZOOM.US/j/123") is recognised the same as a bare URL.
 *
 * Note this returns `teams`, while the server-side `detectPlatform` in
 * recall.server.ts returns `microsoft_teams` for the same URL. The two are
 * not interchangeable: this slug indexes PLATFORM_LABEL.
 */
export function platformOf(url: string): MeetingPlatform | null {
  if (/zoom\.us/i.test(url)) return "zoom";
  if (/meet\.google\.com/i.test(url)) return "google_meet";
  if (/teams\.(microsoft|live)\.com/i.test(url)) return "teams";
  if (/webex\.com/i.test(url)) return "webex";
  return null;
}

/**
 * First candidate MIME type the running browser's `MediaRecorder` claims to
 * support, else `fallback`.
 *
 * The `typeof MediaRecorder === "undefined"` guard is not defensive padding:
 * the module is imported during SSR, and on iOS Safari every WebM candidate
 * fails `isTypeSupported`, so the fallback is the live path there rather than
 * an edge case.
 */
export function pickMime(candidates: string[], fallback: string): string {
  if (typeof MediaRecorder === "undefined") return fallback;
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return fallback;
}
