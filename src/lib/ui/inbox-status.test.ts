import { describe, expect, it } from "vitest";
import {
  bulkSummary,
  classifiedChip,
  emptyInboxHint,
  reanalyzeOutcome,
  searchEmptyState,
  senderFirstName,
  senderInitials,
  syncSummary,
  type SearchEmptyState,
} from "./inbox-status";

describe("classifiedChip", () => {
  it.each([
    ["ai", "ai", "AI", "text-primary"],
    ["filter", "filter", "Rule", "text-foreground"],
    ["gmail_label", "gmail_label", "Gmail label", "text-foreground"],
    // A domain rule is a rule to the reader; the distinction is the
    // classifier's business, not the badge's.
    ["domain_rule", "domain_rule", "Rule", "text-foreground"],
    ["manual_move", "manual_move", "Manual", "text-foreground"],
    ["excluded", "excluded", "Excluded", "text-destructive"],
    ["global_exclude", "global_exclude", "Inbox list", "text-destructive"],
    ["none", "none", "Unclassified", "text-muted-foreground"],
  ])("badges %s", (by, key, label, cls) => {
    expect(classifiedChip(by)).toStrictEqual({ key, label, cls });
  });

  it.each([
    ["a null classifier", null],
    ["an undefined classifier", undefined],
    ["a value the UI has no copy for", "quantum_router"],
  ])("falls back to Unclassified for %s", (_label, by) => {
    expect(classifiedChip(by)).toStrictEqual({
      key: "none",
      label: "Unclassified",
      cls: "text-muted-foreground",
    });
  });

  it.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "does not let the inherited key %s masquerade as a badge",
    (by) => {
      // classified_by is free text from the database. A plain-object lookup
      // answers prototype keys too, and the inherited value would reach the
      // renderer as a function rather than a chip.
      expect(classifiedChip(by)).toStrictEqual({
        key: "none",
        label: "Unclassified",
        cls: "text-muted-foreground",
      });
    },
  );

  it("appends the AI confidence as a whole percent", () => {
    expect(classifiedChip("ai", 0.826)).toStrictEqual({
      key: "ai",
      label: "AI · 83%",
      cls: "text-primary",
    });
  });

  it("shows a zero confidence rather than hiding it", () => {
    expect(classifiedChip("ai", 0).label).toBe("AI · 0%");
  });

  it("omits the percentage when the classifier recorded no confidence", () => {
    expect(classifiedChip("ai", null).label).toBe("AI");
    expect(classifiedChip("ai").label).toBe("AI");
  });

  it("never reports a confidence for a non-AI badge", () => {
    // A stale ai_confidence survives a manual move; surfacing it would credit
    // the classifier for a decision the user made.
    expect(classifiedChip("manual_move", 0.9).label).toBe("Manual");
    expect(classifiedChip(null, 0.9).label).toBe("Unclassified");
  });
});

describe("senderInitials", () => {
  it.each([
    ["a two-word display name", "Dana Reeves", null, "DR"],
    ["a single-word name", "Billing", null, "B"],
    ["only the first two words of a longer name", "Anna Maria Lopez Diaz", null, "AM"],
    ["the address when there is no display name", null, "ceo@acme.com", "C"],
    ["nothing at all", null, null, "?"],
    ["an empty display name, falling through to the address", "", "ops@acme.com", "O"],
  ])("derives %s", (_label, fromName, fromAddr, expected) => {
    expect(senderInitials(fromName, fromAddr)).toBe(expected);
  });

  it("skips words that start with punctuation", () => {
    expect(senderInitials("(Acme) Billing Team", null)).toBe("BT");
  });

  it("falls back to '?' when no word starts with a letter or digit", () => {
    // The "?" is applied after the alphanumeric filter. Applied before it, as
    // it used to be, the filter ate the fallback and the avatar rendered empty.
    expect(senderInitials("<<< >>>", null)).toBe("?");
  });

  it("upper-cases a lower-cased address", () => {
    expect(senderInitials(null, "dana@acme.com")).toBe("D");
  });
});

describe("senderFirstName", () => {
  it.each([
    ["Dana Reeves", null, "Dana"],
    ["Dana", null, "Dana"],
    [null, "dana@acme.com", "dana@acme.com"],
    [null, null, ""],
    ["", "", ""],
  ])("greets %s / %s as %s", (fromName, fromAddr, expected) => {
    expect(senderFirstName(fromName, fromAddr)).toBe(expected);
  });
});

describe("syncSummary", () => {
  it("reports every non-zero count in a fixed order", () => {
    expect(
      syncSummary({ synced: 3, reconciled: { archived: 2, deleted: 1, failed: 4 } }),
    ).toStrictEqual({
      kind: "success",
      message: "Synced · 3 new, 2 archived, 1 removed, 4 failed",
    });
  });

  it("omits the counts that are zero", () => {
    expect(syncSummary({ synced: 3, reconciled: { archived: 0, deleted: 0 } })).toStrictEqual({
      kind: "success",
      message: "Synced · 3 new",
    });
  });

  it("says a bare 'Synced' when nothing changed", () => {
    expect(syncSummary({ synced: 0, reconciled: {} })).toStrictEqual({
      kind: "success",
      message: "Synced",
    });
  });

  it("survives a result with no reconcile block", () => {
    expect(syncSummary({ synced: 1 })).toStrictEqual({
      kind: "success",
      message: "Synced · 1 new",
    });
    expect(syncSummary({ synced: 1, reconciled: null }).message).toBe("Synced · 1 new");
  });

  it("says a bare 'Synced' for an empty or missing result", () => {
    expect(syncSummary({})).toStrictEqual({ kind: "success", message: "Synced" });
    expect(syncSummary(null)).toStrictEqual({ kind: "success", message: "Synced" });
  });

  it("reports an error instead of the counts it managed to collect", () => {
    // "Synced · 3 new" after a half-failed sync sends the user away believing
    // the mailbox is current.
    expect(syncSummary({ synced: 3, error: "rate limited" })).toStrictEqual({
      kind: "error",
      message: "Sync error: rate limited",
    });
  });
});

describe("bulkSummary", () => {
  it("pluralises a clean run", () => {
    expect(bulkSummary("Archived", 4, 0)).toStrictEqual({
      kind: "success",
      message: "Archived 4 emails",
    });
  });

  it("keeps a single email singular", () => {
    expect(bulkSummary("Archived", 1, 0)).toStrictEqual({
      kind: "success",
      message: "Archived 1 email",
    });
  });

  it("warns rather than congratulates on a partial failure", () => {
    expect(bulkSummary("Moved to Travel ·", 5, 2)).toStrictEqual({
      kind: "warning",
      message: "Moved to Travel · 3, 2 failed",
    });
  });

  it("still warns when every single one failed", () => {
    expect(bulkSummary("Archived", 3, 3)).toStrictEqual({
      kind: "warning",
      message: "Archived 0, 3 failed",
    });
  });
});

describe("reanalyzeOutcome", () => {
  const folders = [{ id: "f-travel", name: "Travel" }];

  it("surfaces the classifier's own error text", () => {
    expect(
      reanalyzeOutcome(
        { classified_by: "ai_error", classification_reason: "model timed out" },
        folders,
      ),
    ).toStrictEqual({ kind: "error", message: "model timed out" });
  });

  it("falls back to generic copy when the error carries no reason", () => {
    expect(
      reanalyzeOutcome({ classified_by: "ai_error", classification_reason: null }, folders),
    ).toStrictEqual({ kind: "error", message: "AI classifier failed" });
  });

  it("calls an error an error even though the row also came back unchanged", () => {
    // The error rung has to outrank the no-change rung; "no change" would read
    // as a successful re-run that simply found nothing better.
    expect(reanalyzeOutcome({ classified_by: "ai_error", changed: false }, folders).kind).toBe(
      "error",
    );
  });

  it("names the folder the classifier deliberately kept it in", () => {
    expect(
      reanalyzeOutcome({ classified_by: "kept", folder_id: "f-travel" }, folders),
    ).toStrictEqual({ kind: "message", message: "No better folder — kept in Travel." });
  });

  it("keeps the 'kept' verdict readable when the folder is unknown", () => {
    expect(reanalyzeOutcome({ classified_by: "kept", folder_id: "f-gone" }, folders)).toStrictEqual(
      { kind: "message", message: "No better folder — kept current." },
    );
  });

  it("reports a no-op run", () => {
    expect(reanalyzeOutcome({ classified_by: "ai", changed: false }, folders)).toStrictEqual({
      kind: "success",
      message: "Re-analyzed — no change",
    });
  });

  it("names the destination folder for a routed email", () => {
    expect(
      reanalyzeOutcome(
        { classified_by: "ai", changed: true, folder_id: "f-travel", folder_name: "Travel" },
        folders,
      ),
    ).toStrictEqual({ kind: "success", message: "Re-analyzed → Travel" });
  });

  it("reports a move back to the inbox when no folder came back", () => {
    expect(reanalyzeOutcome({ classified_by: "ai", changed: true }, folders)).toStrictEqual({
      kind: "success",
      message: "Re-analyzed → Inbox",
    });
  });

  it("treats a folder id with no name as a move to the inbox", () => {
    // Both halves are needed to name a destination; half a pair would render
    // "Re-analyzed → undefined".
    expect(
      reanalyzeOutcome({ changed: true, folder_id: "f-travel", folder_name: null }, folders)
        .message,
    ).toBe("Re-analyzed → Inbox");
  });

  it("reads an empty result as no change", () => {
    expect(reanalyzeOutcome({}, folders).message).toBe("Re-analyzed — no change");
  });
});

describe("searchEmptyState", () => {
  function state(over: Partial<Parameters<typeof searchEmptyState>[0]> = {}): SearchEmptyState {
    return searchEmptyState({
      gmailSearching: false,
      reason: undefined,
      found: 0,
      fetching: false,
      ...over,
    });
  }

  it("shows the in-flight panel while Gmail is still being asked", () => {
    expect(state({ gmailSearching: true })).toBe("checking_gmail");
  });

  it("lets the in-flight panel outrank the previous call's reason", () => {
    // The reason on screen belongs to the last search; announcing it while a
    // new one runs shows a failure the user has already moved past.
    expect(state({ gmailSearching: true, reason: "reauth_required", found: 9 })).toBe(
      "checking_gmail",
    );
  });

  it.each([
    ["no_account", "no_account"],
    ["reauth_required", "reauth_required"],
    ["rate_limited", "rate_limited"],
  ] as const)("surfaces the %s failure", (reason, expected) => {
    expect(state({ reason })).toBe(expected);
  });

  it("prefers a concrete failure over the hits it also reported", () => {
    expect(state({ reason: "rate_limited", found: 12 })).toBe("rate_limited");
  });

  it("ignores a reason it has no copy for", () => {
    expect(state({ reason: "something_new" })).toBe("no_matches");
  });

  it("asks the user to wait while found rows are still being ingested", () => {
    expect(state({ found: 4, fetching: true })).toBe("pulling");
  });

  it("admits the hits could not be loaded once the fetch settles", () => {
    expect(state({ found: 4, fetching: false })).toBe("found_but_unloadable");
  });

  it("says there are no matches only when Gmail found none either", () => {
    expect(state()).toBe("no_matches");
    expect(state({ found: 0, fetching: true })).toBe("no_matches");
  });
});

describe("emptyInboxHint", () => {
  it("points a connected user at refresh", () => {
    expect(emptyInboxHint(true, false)).toBe("Hit refresh, or check All mail.");
  });

  it("blames the failed account read rather than the user's setup", () => {
    // "Connect Gmail in Settings" sends a user who already connected Gmail on
    // a pointless errand.
    expect(emptyInboxHint(false, true)).toBe("Reload Gmail accounts, then refresh.");
  });

  it("asks an unconnected user to connect Gmail", () => {
    expect(emptyInboxHint(false, false)).toBe("Connect Gmail in Settings.");
  });

  it("prefers the refresh hint when accounts loaded despite an earlier error", () => {
    expect(emptyInboxHint(true, true)).toBe("Hit refresh, or check All mail.");
  });
});
