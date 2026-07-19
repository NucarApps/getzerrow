// Barrel: re-exports every Gmail server function from its per-domain
// sibling under `src/lib/gmail/`. Existing call sites keep importing
// from `@/lib/gmail.functions` unchanged; new work should import from
// the specific domain file for faster IDE navigation.
//
// Split boundaries and shared helpers live in `gmail-helpers.server.ts`.
export * from "./gmail/accounts.functions";
export * from "./gmail/domain.functions";
export * from "./gmail/sync.functions";
export * from "./gmail/folder-mgmt.functions";
export * from "./gmail/move.functions";
export * from "./gmail/reprocess.functions";
export * from "./gmail/rules.functions";
