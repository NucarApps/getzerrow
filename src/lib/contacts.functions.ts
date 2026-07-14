// Barrel: re-exports every Contacts server function from its per-domain
// sibling under `src/lib/contacts/`. Existing call sites keep importing
// from `@/lib/contacts.functions` unchanged; new work should import from
// the specific domain file for faster IDE navigation.
//
// Split boundaries and shared helpers live in `contacts-helpers.server.ts`.
export * from "./contacts/crud.functions";
export * from "./contacts/enrich.functions";
export * from "./contacts/scan.functions";
export * from "./contacts/share.functions";
// Public helper re-exports so existing importers keep working.
export { normalizeName } from "./contacts-helpers.server";
