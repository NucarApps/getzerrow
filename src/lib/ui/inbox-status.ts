// The copy and badge decisions the inbox makes about *what just happened*,
// lifted out of `routes/_authenticated/inbox.tsx`.
//
// These are ladders: several mutually exclusive outcomes where the order of
// the rungs is the contract. Reporting "Synced" after a failed sync, or
// "no change" after a classifier error, is a lie the user acts on, so each
// rung is worth an assertion.

/** The `classified_by` values the UI has a badge for. */
export type ClassifiedChipKey =
  | "ai"
  | "filter"
  | "gmail_label"
  | "domain_rule"
  | "manual_move"
  | "excluded"
  | "global_exclude"
  | "none";

export type ClassifiedChip = {
  /** Which icon the route should render. */
  key: ClassifiedChipKey;
  label: string;
  /** Tailwind colour class for the chip. */
  cls: string;
};

const CHIP_NONE: ClassifiedChip = {
  key: "none",
  label: "Unclassified",
  cls: "text-muted-foreground",
};

const CHIPS: Record<ClassifiedChipKey, ClassifiedChip> = {
  ai: { key: "ai", label: "AI", cls: "text-primary" },
  filter: { key: "filter", label: "Rule", cls: "text-foreground" },
  gmail_label: { key: "gmail_label", label: "Gmail label", cls: "text-foreground" },
  // A domain rule is still a rule as far as the reader is concerned — the
  // distinction only matters to the classifier.
  domain_rule: { key: "domain_rule", label: "Rule", cls: "text-foreground" },
  manual_move: { key: "manual_move", label: "Manual", cls: "text-foreground" },
  excluded: { key: "excluded", label: "Excluded", cls: "text-destructive" },
  global_exclude: { key: "global_exclude", label: "Inbox list", cls: "text-destructive" },
  none: CHIP_NONE,
};

/**
 * The provenance badge for a row.
 *
 * `classified_by` is a free-text column, so an unrecognised value has to fall
 * back rather than render blank. The own-property check is load-bearing: a
 * plain-object lookup answers inherited keys too, so a value of "constructor"
 * would otherwise sail past the `??` and hand a function to the renderer.
 *
 * The confidence percentage is only appended for the AI rung — a rule match
 * has no confidence to report, and a stale `ai_confidence` left on a
 * manually-moved row must not resurface as "Manual · 82%".
 */
export function classifiedChip(
  by: string | null | undefined,
  confidence?: number | null,
): ClassifiedChip {
  const key = by ?? "none";
  const chip = Object.hasOwn(CHIPS, key)
    ? (CHIPS[key as ClassifiedChipKey] ?? CHIP_NONE)
    : CHIP_NONE;
  if (chip.key !== "ai" || confidence == null) return chip;
  return { ...chip, label: `${chip.label} · ${Math.round(confidence * 100)}%` };
}

/**
 * Up to two initials for the sender avatar.
 *
 * Non-alphanumeric leading characters are dropped so a display name like
 * `"<no-reply>"` or `"(Acme) Billing"` yields letters rather than punctuation,
 * and the address is the fallback when there is no display name at all.
 *
 * The "?" is applied AFTER that filter, not before it: as a pre-filter
 * fallback the question mark was itself non-alphanumeric and got dropped, so
 * an unidentifiable sender drew an empty avatar circle instead of a "?".
 */
export function senderInitials(
  fromName: string | null | undefined,
  fromAddr: string | null | undefined,
): string {
  const initials = (fromName || fromAddr || "")
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .filter((c) => /[a-z0-9]/i.test(c))
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return initials || "?";
}

/**
 * First word of the sender's name, used for "Reply to Dana…". Empty when
 * there is nothing to address, which the caller turns into "sender".
 */
export function senderFirstName(
  fromName: string | null | undefined,
  fromAddr: string | null | undefined,
): string {
  return (fromName || fromAddr || "").split(/\s+/)[0] ?? "";
}

export type SyncResult = {
  reconciled?: { archived?: number; deleted?: number; failed?: number } | null;
  synced?: number;
  error?: string;
} | null;

export type Toast = { kind: "success" | "error" | "warning" | "message"; message: string };

/**
 * Summarise a manual Refresh.
 *
 * A reported `error` wins over any counts: the sync partially ran, and calling
 * that "Synced · 3 new" would hide the half that failed. With no counts at all
 * the message stays a bare "Synced" rather than an empty tail.
 */
export function syncSummary(res: SyncResult): Toast {
  if (res?.error) return { kind: "error", message: `Sync error: ${res.error}` };
  const r = res?.reconciled;
  const parts: string[] = [];
  if (typeof res?.synced === "number" && res.synced > 0) parts.push(`${res.synced} new`);
  if (r?.archived) parts.push(`${r.archived} archived`);
  if (r?.deleted) parts.push(`${r.deleted} removed`);
  if (r?.failed) parts.push(`${r.failed} failed`);
  return {
    kind: "success",
    message: parts.length ? `Synced · ${parts.join(", ")}` : "Synced",
  };
}

/**
 * Summarise a bulk action over the selection.
 *
 * A partial failure is a warning, not a success — the user still has rows that
 * did not move, and a green toast would send them away believing otherwise.
 */
export function bulkSummary(verb: string, total: number, failed: number): Toast {
  const ok = total - failed;
  if (failed === 0) {
    return { kind: "success", message: `${verb} ${ok} email${ok === 1 ? "" : "s"}` };
  }
  return { kind: "warning", message: `${verb} ${ok}, ${failed} failed` };
}

export type ReanalyzeResult = {
  classified_by?: string | null;
  classification_reason?: string | null;
  changed?: boolean;
  folder_id?: string | null;
  folder_name?: string | null;
};

/**
 * Report the outcome of re-running the classifier over one email.
 *
 * The order is the contract: a classifier error is an error even though the
 * row also comes back "unchanged", and an explicit "kept" verdict — the
 * classifier looked and chose to leave it alone — reads differently from the
 * no-op case where nothing was decided.
 */
export function reanalyzeOutcome(
  result: ReanalyzeResult,
  folders: readonly { id: string; name: string }[],
): Toast {
  if (result.classified_by === "ai_error") {
    return { kind: "error", message: result.classification_reason || "AI classifier failed" };
  }
  if (result.classified_by === "kept") {
    const name = folders.find((f) => f.id === result.folder_id)?.name;
    return {
      kind: "message",
      message: name ? `No better folder — kept in ${name}.` : "No better folder — kept current.",
    };
  }
  if (!result.changed) return { kind: "success", message: "Re-analyzed — no change" };
  if (result.folder_id && result.folder_name) {
    return { kind: "success", message: `Re-analyzed → ${result.folder_name}` };
  }
  return { kind: "success", message: "Re-analyzed → Inbox" };
}

/** Which empty-state panel to render when a search returns nothing. */
export type SearchEmptyState =
  | "checking_gmail"
  | "no_account"
  | "reauth_required"
  | "rate_limited"
  | "pulling"
  | "found_but_unloadable"
  | "no_matches";

/**
 * Pick the empty-state for a search with no rows.
 *
 * The rungs are ordered by how much they explain: a Gmail call still in flight
 * outranks anything derived from the previous call's result, and a concrete
 * failure reason outranks the generic "found some, still loading". The last
 * two rungs are the difference between "wait a moment" and "something went
 * wrong" — telling the user there are no matches while Gmail is mid-ingest is
 * the failure this ladder exists to avoid.
 */
export function searchEmptyState({
  gmailSearching,
  reason,
  found,
  fetching,
}: {
  gmailSearching: boolean;
  reason: string | undefined;
  found: number;
  fetching: boolean;
}): SearchEmptyState {
  if (gmailSearching) return "checking_gmail";
  if (reason === "no_account") return "no_account";
  if (reason === "reauth_required") return "reauth_required";
  if (reason === "rate_limited") return "rate_limited";
  if (found > 0) return fetching ? "pulling" : "found_but_unloadable";
  return "no_matches";
}

/**
 * The hint under the empty non-search inbox. A failed account read is called
 * out separately from having no accounts: "Connect Gmail in Settings" sends a
 * user who already connected Gmail on a pointless errand.
 */
export function emptyInboxHint(hasConnectedAccounts: boolean, accountsFailed: boolean): string {
  if (hasConnectedAccounts) return "Hit refresh, or check All mail.";
  if (accountsFailed) return "Reload Gmail accounts, then refresh.";
  return "Connect Gmail in Settings.";
}
