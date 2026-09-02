// One typed AccountContext builder for the classify/decide-folder suites.
//
// Four suites hand-rolled this object, three of them through
// `as unknown as AccountContext` — which meant a field added to
// AccountContext (senderGroups, markReadRules, accountEmail) silently read
// as undefined in tests that had not been updated, and the cast hid it.
// Built here against the real type so a new field is a compile error in one
// place instead of a runtime `undefined` in twenty.
//
// Lives in __fixtures__ so it is excluded from the `src/**/*.test.ts` glob
// and never ships: only test files import it.
import type { AccountContext } from "../account-context";

export function makeAccountContext(over: Partial<AccountContext> = {}): AccountContext {
  return {
    folders: [],
    filters: [],
    overrides: [],
    overrideExceptions: [],
    // Default to the folders themselves so a test that gives a folder an
    // ai_rule does not also have to remember to enrich it.
    enrichedFolders: (over.folders ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      ai_rule: f.ai_rule,
    })),
    calendarGuardEnabled: false,
    calendarContacts: new Set<string>(),
    accountEmail: "me@example.com",
    senderGroups: new Map<string, Set<string>>(),
    ...over,
  };
}
