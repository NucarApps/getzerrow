// Barrel: re-exports every Meetings server function from its per-domain
// sibling under `src/lib/meetings/`. Existing call sites keep importing
// from `@/lib/meetings.functions` unchanged; new work should import from
// the specific domain file for faster IDE navigation.
//
// Split boundaries and shared helpers live in `meetings-helpers.server.ts`.
export * from "./meetings/recording.functions";
export * from "./meetings/crud.functions";
export * from "./meetings/auto-record.functions";
export * from "./meetings/calendar.functions";
export * from "./meetings/blocklist.functions";
export * from "./meetings/bot-settings.functions";
export * from "./meetings/event-prefs.functions";
export { extractMeetingUrl } from "./meetings-helpers.server";
