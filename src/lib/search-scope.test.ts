// These tests pin the whole-mailbox search scope contract. Regression context:
// search results were once silently filtered down to the currently-selected
// inbox view, which discarded every archived, folder-filed, or replied-to hit
// and left the UI stuck on "Pulling N matches from Gmail…" with nothing
// rendered (an apparent "hang"). matchesSearchScope must therefore KEEP those
// messages, and only drop rows that genuinely aren't ready to show
// (still-classifying or currently-snoozed). emailBelongsInScope still enforces
// the narrow per-folder inbox scope for the non-search list views.
import { describe, it, expect } from "vitest";
import {
  matchesSearchScope,
  emailBelongsInScope,
  isInProgressEmail,
  isSnoozed,
  type ScopeEmail,
  type ScopeFolder,
} from "./search-scope";

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + 24 * HOUR).toISOString();
const past = () => new Date(Date.now() - 24 * HOUR).toISOString();

function email(over: Partial<ScopeEmail> = {}): ScopeEmail {
  return {
    classified_by: "classified_by" in over ? over.classified_by ?? null : "ai",
    snoozed_until: "snoozed_until" in over ? over.snoozed_until : null,
    is_archived: over.is_archived ?? false,
    folder_id: "folder_id" in over ? over.folder_id ?? null : null,
    raw_labels: "raw_labels" in over ? over.raw_labels : ["INBOX"],
  };
}

const FOLDERS: ScopeFolder[] = [
  { id: "f-plain", auto_archive: false, hide_from_inbox: false },
  { id: "f-archive", auto_archive: true, hide_from_inbox: false },
  { id: "f-hidden", auto_archive: false, hide_from_inbox: true },
];

describe("matchesSearchScope (whole-mailbox search)", () => {
  it("keeps an archived message so archived hits are never dropped", () => {
    expect(
      matchesSearchScope(email({ is_archived: true, raw_labels: [] })),
    ).toBe(true);
  });

  it("keeps a folder-filed message even when its folder hides it from the inbox", () => {
    expect(
      matchesSearchScope(email({ folder_id: "f-hidden", raw_labels: ["Label_99"] })),
    ).toBe(true);
  });

  it("keeps a replied-to / threaded message that has left the INBOX label", () => {
    expect(
      matchesSearchScope(
        email({ is_archived: true, raw_labels: ["SENT"], folder_id: "f-plain" }),
      ),
    ).toBe(true);
  });

  it("keeps an ordinary inbox message", () => {
    expect(matchesSearchScope(email())).toBe(true);
  });

  it("drops a still-classifying message (not safe to show yet)", () => {
    expect(matchesSearchScope(email({ classified_by: "pending" }))).toBe(false);
    expect(matchesSearchScope(email({ classified_by: "pending_ai" }))).toBe(false);
  });

  it("drops a currently-snoozed message but keeps one whose snooze has passed", () => {
    expect(matchesSearchScope(email({ snoozed_until: future() }))).toBe(false);
    expect(matchesSearchScope(email({ snoozed_until: past() }))).toBe(true);
  });

  it("never empties a result set made of archived/filed/replied rows (no hang)", () => {
    const rows = [
      email({ is_archived: true, raw_labels: [] }), // archived
      email({ folder_id: "f-hidden", raw_labels: ["Label_99"] }), // filed + hidden
      email({ is_archived: true, raw_labels: ["SENT"], folder_id: "f-plain" }), // replied
    ];
    const kept = rows.filter(matchesSearchScope);
    expect(kept).toHaveLength(rows.length);
  });

  it("is safe to pass straight to Array.prototype.filter (index arg is ignored)", () => {
    // filter() calls the predicate with (value, index, array); the extra args
    // must not change the result, otherwise later rows would be mis-scoped.
    const rows = Array.from({ length: 5 }, () => email({ is_archived: true }));
    expect(rows.filter(matchesSearchScope)).toHaveLength(5);
  });
});

describe("emailBelongsInScope (narrow per-view inbox scope)", () => {
  it("'all_mail' accepts everything, including in-progress and snoozed", () => {
    expect(emailBelongsInScope(email({ classified_by: "pending" }), "all_mail", FOLDERS)).toBe(true);
    expect(emailBelongsInScope(email({ snoozed_until: future() }), "all_mail", FOLDERS)).toBe(true);
    expect(emailBelongsInScope(email({ is_archived: true }), "all_mail", FOLDERS)).toBe(true);
  });

  it("'all' (main inbox) excludes archived, filed, and hidden-folder mail", () => {
    expect(emailBelongsInScope(email(), "all", FOLDERS)).toBe(true);
    expect(emailBelongsInScope(email({ is_archived: true }), "all", FOLDERS)).toBe(false);
    expect(emailBelongsInScope(email({ raw_labels: [] }), "all", FOLDERS)).toBe(false);
    expect(
      emailBelongsInScope(email({ folder_id: "f-archive", raw_labels: ["INBOX"] }), "all", FOLDERS),
    ).toBe(false);
    expect(
      emailBelongsInScope(email({ folder_id: "f-hidden", raw_labels: ["INBOX"] }), "all", FOLDERS),
    ).toBe(false);
  });

  it("'no_rules' only accepts unfiled mail with no Label_* labels", () => {
    expect(emailBelongsInScope(email({ folder_id: null, raw_labels: ["INBOX"] }), "no_rules", FOLDERS)).toBe(true);
    expect(emailBelongsInScope(email({ folder_id: "f-plain" }), "no_rules", FOLDERS)).toBe(false);
    expect(emailBelongsInScope(email({ folder_id: null, raw_labels: ["Label_1"] }), "no_rules", FOLDERS)).toBe(false);
  });

  it("a specific folder id only accepts mail filed into that folder", () => {
    expect(emailBelongsInScope(email({ folder_id: "f-plain" }), "f-plain", FOLDERS)).toBe(true);
    expect(emailBelongsInScope(email({ folder_id: "f-archive" }), "f-plain", FOLDERS)).toBe(false);
  });

  it("drops in-progress and snoozed mail from every non-'all_mail' view", () => {
    expect(emailBelongsInScope(email({ classified_by: "pending", folder_id: "f-plain" }), "f-plain", FOLDERS)).toBe(false);
    expect(emailBelongsInScope(email({ snoozed_until: future(), folder_id: "f-plain" }), "f-plain", FOLDERS)).toBe(false);
  });
});

describe("scope helpers", () => {
  it("isInProgressEmail only flags pending classifications", () => {
    expect(isInProgressEmail({ classified_by: "pending" })).toBe(true);
    expect(isInProgressEmail({ classified_by: "pending_ai" })).toBe(true);
    expect(isInProgressEmail({ classified_by: "ai" })).toBe(false);
    expect(isInProgressEmail({ classified_by: null })).toBe(false);
  });

  it("isSnoozed reflects whether the snooze is still in the future", () => {
    expect(isSnoozed({ snoozed_until: future() })).toBe(true);
    expect(isSnoozed({ snoozed_until: past() })).toBe(false);
    expect(isSnoozed({ snoozed_until: null })).toBe(false);
    expect(isSnoozed({})).toBe(false);
  });
});
