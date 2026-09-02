// Banner and badge state for the per-account health card.
//
// Each of these turns a raw account field into something an operator acts on
// — "your watch expired", "reconnect Gmail", "12 jobs requeued" — so the
// boundaries (a watch that expires in an hour vs a day, a diagnostic that
// says reconnect vs one that merely errored) are the whole product here.

/**
 * What the watch badge says. `healthy` drives the tick-vs-warning icon and
 * the destructive colour; `state` picks the verb.
 */
export type WatchStatus = {
  state: "expired" | "expiring" | "renews";
  healthy: boolean;
};

/** A watch expiring within this window is called out as "expiring". */
export const WATCH_EXPIRING_MS = 24 * 60 * 60 * 1000;

export function watchStatus(watchExpiresAt: string | null | undefined, now: number): WatchStatus {
  const expiresAt = watchExpiresAt ? new Date(watchExpiresAt).getTime() : NaN;
  // An absent or unparseable expiry is treated as no live watch at all: the
  // push subscription is not known to be armed, and saying so is the safe
  // side of the error.
  if (!(expiresAt > now)) return { state: "expired", healthy: false };
  return expiresAt - now < WATCH_EXPIRING_MS
    ? { state: "expiring", healthy: true }
    : { state: "renews", healthy: true };
}

/** The result shape `runAccountDiagnostic` reports back. */
export type DiagnosticResult = {
  accessToken: string;
  watch: string;
  error?: string | null;
  watchExpiresAt?: string | null;
};

export type DiagnosticOutcome = {
  kind: "needs_reconnect" | "error" | "ok";
  message: string;
};

/**
 * Turn a diagnostic run into the sentence the user is shown.
 *
 * `formatExpiry` is injected rather than imported so the sentence can be
 * asserted without a clock.
 */
export function describeDiagnostic(
  r: DiagnosticResult,
  formatExpiry: (iso: string) => string,
): DiagnosticOutcome {
  if (r.accessToken === "needs_reconnect") {
    return {
      kind: "needs_reconnect",
      message: "Reconnect required: " + (r.error ?? "OAuth token expired"),
    };
  }
  if (r.accessToken === "error" || r.watch === "error") {
    return { kind: "error", message: r.error ?? "Diagnostic failed" };
  }
  return {
    kind: "ok",
    message: `OAuth ok · watch ${r.watch}${
      r.watchExpiresAt ? " · " + formatExpiry(r.watchExpiresAt) : ""
    }`,
  };
}

/** Why the account list is empty: nothing connected, or nothing selected. */
export function emptyAccountsMessage(connectedAccounts: number): string {
  return connectedAccounts === 0
    ? "No Gmail accounts connected yet."
    : "Pick an inbox above to see its status.";
}

/** Confirmation after retrying an account's dead-lettered jobs. */
export function requeuedMessage(requeued: number): string {
  return `Requeued ${requeued} failed job${requeued === 1 ? "" : "s"}`;
}
