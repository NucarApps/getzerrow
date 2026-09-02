// Human names for the card_events event types shown in the activity feed.

/**
 * The reader-facing name of a card event. An unrecognised type is shown
 * verbatim rather than hidden, so a new event type is visible in the feed the
 * day it starts being written instead of silently disappearing.
 */
export function cardEventLabel(t: string): string {
  return t === "view"
    ? "Viewed"
    : t === "link_click"
      ? "Clicked link"
      : t === "vcard_download"
        ? "Saved vCard"
        : t === "share"
          ? "Shared"
          : t;
}
