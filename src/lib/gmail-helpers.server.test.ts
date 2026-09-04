// The four ownership helpers are the app's IDOR chokepoint.
//
// Roughly forty server fns take a client-supplied id, run on the
// service-role client (which bypasses RLS), and delegate the entire
// ownership question to `getOwnedAccount` / `getEmailAccount` /
// `getOwnedFolder` / `getOwnedSchedule`. Those fns' own tests mock these
// helpers, so a regression here would be invisible everywhere while
// unlocking every one of them at once. They are tested directly for that
// reason.
//
// The shape is identical in all four and each part of it matters:
//   * the row is looked up by id ALONE — deliberately, so that a foreign
//     row is fetched and then refused, rather than looking like it does
//     not exist,
//   * a missing row and a foreign row raise DIFFERENT errors, because
//     "not found" and "not yours" are different situations for the caller
//     (and only one of them is worth alerting on),
//   * the guard is `!==` on the row's own user_id, so a row with a null
//     or undefined owner is refused rather than treated as public.
//
// `restoreEmailToInbox` and `drainCatchupRounds` live here too and are
// covered below: the first because it is the shared eviction path four
// call sites used to inline, the second because its stopping conditions
// are what keep a sync request under the Safari "Load failed" wall.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const getEmailsDecrypted = vi.fn(async () => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/sync/encrypted-reader", () => ({
  getEmailsDecrypted: (...a: unknown[]) => getEmailsDecrypted(...(a as [])),
}));

const updateEmailEncrypted = vi.fn(async (_patch: Record<string, unknown>) => ({ error: null }));
vi.mock("@/lib/sync/encrypted-writer", () => ({
  updateEmailEncrypted: (...a: unknown[]) =>
    updateEmailEncrypted(...(a as [Record<string, unknown>])),
}));

const modifyMessage = vi.fn(async () => {});
vi.mock("./gmail.server", () => ({
  modifyMessage: (...a: unknown[]) => modifyMessage(...(a as [])),
}));

const bulkCatchupClaim = vi.fn();
vi.mock("./sync.server", () => ({
  bulkCatchupClaim: (...a: unknown[]) => bulkCatchupClaim(...(a as [])),
}));

const logError = vi.fn();
vi.mock("./log.server", () => ({ logError: (...a: unknown[]) => logError(...(a as [])) }));

const {
  getOwnedAccount,
  getEmailAccount,
  getOwnedFolder,
  getOwnedSchedule,
  restoreEmailToInbox,
  drainCatchupRounds,
  ianaTz,
} = await import("./gmail-helpers.server");

const OWNER = "owner-1";
const ATTACKER = "attacker-1";

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  vi.useRealTimers();
  getEmailsDecrypted.mockResolvedValue({ rows: [] });
  updateEmailEncrypted.mockResolvedValue({ error: null });
  modifyMessage.mockResolvedValue(undefined);
});

// One table + helper per row; the four share a shape, so they share a table.
const HELPERS = [
  {
    name: "getOwnedAccount",
    table: "gmail_accounts" as const,
    call: (userId: string, id: string) => getOwnedAccount(userId, id),
    missing: "Gmail account not found",
    foreign: "Not authorized for this account",
  },
  {
    name: "getOwnedFolder",
    table: "folders" as const,
    call: (userId: string, id: string) => getOwnedFolder(userId, id),
    missing: "Folder not found",
    foreign: "Not authorized",
  },
  {
    name: "getOwnedSchedule",
    table: "folder_summary_schedules" as const,
    call: (userId: string, id: string) => getOwnedSchedule(userId, id),
    missing: "Schedule not found",
    foreign: "Not authorized",
  },
  {
    name: "getEmailAccount",
    table: "emails" as const,
    call: (userId: string, id: string) => getEmailAccount(userId, id),
    missing: "Email not found",
    foreign: "Not authorized",
  },
];

describe.each(HELPERS)("$name", ({ table, call, missing, foreign }) => {
  it("returns the row to its owner", async () => {
    fake.seedRaw(table, [{ id: "row-1", user_id: OWNER }]);
    await expect(call(OWNER, "row-1")).resolves.toBeTruthy();
  });

  it("refuses a row belonging to somebody else", async () => {
    fake.seedRaw(table, [{ id: "row-1", user_id: OWNER }]);
    await expect(call(ATTACKER, "row-1")).rejects.toThrow(foreign);
  });

  it("says not-found rather than not-authorized for a row that does not exist", async () => {
    // The two are different situations for the caller, and only one of
    // them is worth alerting on.
    await expect(call(OWNER, "missing")).rejects.toThrow(missing);
  });

  it("treats a read error as not-found", async () => {
    fake.onSelect(table, () => ({ message: "connection reset" }));
    await expect(call(OWNER, "row-1")).rejects.toThrow(missing);
  });

  it("refuses a row with no owner rather than treating it as public", async () => {
    fake.seedRaw(table, [{ id: "row-1", user_id: null }]);
    await expect(call(OWNER, "row-1")).rejects.toThrow(foreign);
  });

  it("looks the row up by id alone, so a foreign row is refused not hidden", async () => {
    // Filtering by user_id here would make a foreign id indistinguishable
    // from a deleted one, which is a worse error for the caller and a
    // weaker signal for anyone watching the logs.
    fake.seedRaw(table, [{ id: "row-1", user_id: OWNER }]);
    await call(OWNER, "row-1");
    expect(fake.calls.selects[0]).toMatchObject({
      table,
      filters: [{ op: "eq", col: "id", value: "row-1" }],
    });
  });
});

describe("getEmailAccount decrypted fields", () => {
  const seed = () =>
    fake.seedRaw("emails", [
      {
        id: "e1",
        user_id: OWNER,
        gmail_message_id: "m1",
        gmail_account_id: "acct-1",
        thread_id: "t1",
        from_addr: "sender@example.test",
      },
    ]);

  it("merges the decrypted fields onto the plaintext metadata", async () => {
    seed();
    getEmailsDecrypted.mockResolvedValue({
      rows: [{ subject: "Invoice", body_text: "body", from_name: "Ann" }],
    });

    await expect(getEmailAccount(OWNER, "e1")).resolves.toEqual({
      gmail_message_id: "m1",
      gmail_account_id: "acct-1",
      user_id: OWNER,
      thread_id: "t1",
      from_addr: "sender@example.test",
      subject: "Invoice",
      body_text: "body",
      from_name: "Ann",
    });
  });

  it("nulls the decrypted fields when there is no ciphertext to read", async () => {
    seed();
    getEmailsDecrypted.mockResolvedValue({ rows: [] });

    const row = await getEmailAccount(OWNER, "e1");
    expect(row).toMatchObject({ subject: null, body_text: null, from_name: null });
    expect(row.gmail_message_id).toBe("m1");
  });

  it("does not decrypt a row it refused", async () => {
    // Decrypting first would put another user's body in memory even
    // though the call is about to throw.
    fake.seedRaw("emails", [{ id: "e1", user_id: OWNER }]);
    await expect(getEmailAccount(ATTACKER, "e1")).rejects.toThrow("Not authorized");
    expect(getEmailsDecrypted).not.toHaveBeenCalled();
  });
});

describe("restoreEmailToInbox", () => {
  const base = {
    emailId: "e1",
    gmailAccountId: "acct-1",
    gmailMessageId: "m1",
    currentLabels: ["Label_9", "UNREAD"],
    fromLabel: "Label_9",
    classifiedBy: "user",
    classificationReason: "Moved back to inbox",
    labelFailureLog: { event: "gmail.restore_label_failed" },
  };

  it("drops the folder label and adds INBOX", async () => {
    await restoreEmailToInbox(base);
    expect(fake.calls.updates[0]?.payload).toMatchObject({
      folder_id: null,
      is_archived: false,
      classified_by: "user",
      matched_filter_ids: [],
      raw_labels: ["UNREAD", "INBOX"],
    });
  });

  it("does not duplicate INBOX when it is already there", async () => {
    await restoreEmailToInbox({ ...base, currentLabels: ["INBOX", "Label_9"] });
    expect((fake.calls.updates[0]?.payload as { raw_labels: string[] }).raw_labels).toEqual([
      "INBOX",
    ]);
  });

  it("keeps every label when the email was in no folder", async () => {
    await restoreEmailToInbox({ ...base, fromLabel: null });
    expect((fake.calls.updates[0]?.payload as { raw_labels: string[] }).raw_labels).toEqual([
      "Label_9",
      "UNREAD",
      "INBOX",
    ]);
  });

  it("leaves ai_confidence and ai_summary untouched unless passed", async () => {
    // Callers that do not mention them must not have them zeroed.
    await restoreEmailToInbox(base);
    expect(fake.calls.updates[0]?.payload).not.toHaveProperty("ai_confidence");
    expect(updateEmailEncrypted.mock.calls[0]![0]).not.toHaveProperty("ai_summary");
  });

  it("writes ai_confidence and ai_summary when they are passed, null included", async () => {
    await restoreEmailToInbox({ ...base, aiConfidence: null, aiSummary: "" });
    expect(fake.calls.updates[0]?.payload).toMatchObject({ ai_confidence: null });
    expect(updateEmailEncrypted.mock.calls[0]![0]).toMatchObject({ ai_summary: "" });
  });

  it("writes the reason through the encrypted writer, not the plaintext update", async () => {
    await restoreEmailToInbox(base);
    expect(updateEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({ email_id: "e1", classification_reason: "Moved back to inbox" }),
    );
    expect(fake.calls.updates[0]?.payload).not.toHaveProperty("classification_reason");
  });

  it("mirrors the change into Gmail", async () => {
    await restoreEmailToInbox(base);
    expect(modifyMessage).toHaveBeenCalledWith("acct-1", "m1", ["INBOX"], ["Label_9"]);
  });

  it("removes nothing in Gmail when the email was in no folder", async () => {
    await restoreEmailToInbox({ ...base, fromLabel: null });
    expect(modifyMessage).toHaveBeenCalledWith("acct-1", "m1", ["INBOX"], []);
  });

  it("skips Gmail entirely for a row with no message id", async () => {
    await restoreEmailToInbox({ ...base, gmailMessageId: null });
    expect(modifyMessage).not.toHaveBeenCalled();
    // The local move still happened.
    expect(fake.calls.updates).toHaveLength(1);
  });

  it("keeps the local move when the Gmail write fails", async () => {
    // Gmail is best-effort here: the user asked for the mail to come back,
    // and a label that failed to sync is fixed by the next reconcile.
    modifyMessage.mockRejectedValue(new Error("Gmail 503"));
    await expect(restoreEmailToInbox(base)).resolves.toBeUndefined();

    expect(fake.calls.updates).toHaveLength(1);
    expect(logError).toHaveBeenCalledWith("gmail.restore_label_failed", {}, expect.any(Error));
  });

  it("passes the caller's log payload through", async () => {
    modifyMessage.mockRejectedValue(new Error("Gmail 503"));
    await restoreEmailToInbox({
      ...base,
      labelFailureLog: { event: "gmail.bulk_restore_failed", payload: { batch: 3 } },
    });
    expect(logError).toHaveBeenCalledWith(
      "gmail.bulk_restore_failed",
      { batch: 3 },
      expect.any(Error),
    );
  });
});

describe("drainCatchupRounds", () => {
  const round = (over: Partial<Record<string, number | boolean>> = {}) => ({
    scanned: 10,
    inserted: 10,
    ai_pending: 2,
    fetch_failed: 0,
    overflowed: true,
    ...over,
  });

  it("stops as soon as a round claims nothing", async () => {
    bulkCatchupClaim.mockResolvedValue(round({ scanned: 0, inserted: 0, overflowed: true }));
    const res = await drainCatchupRounds("acct-1", OWNER, "sync.catchup_failed");

    expect(bulkCatchupClaim).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ rounds: 1, scanned: 0 });
  });

  it("stops once the queue is no longer overflowing", async () => {
    bulkCatchupClaim
      .mockResolvedValueOnce(round())
      .mockResolvedValueOnce(round({ overflowed: false }));

    const res = await drainCatchupRounds("acct-1", OWNER, "sync.catchup_failed");

    expect(bulkCatchupClaim).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ rounds: 2, scanned: 20, inserted: 20, overflowed: false });
  });

  it("stops at the round cap even while the queue is still overflowing", async () => {
    // The rest falls back to the cron lane rather than holding the
    // request open.
    bulkCatchupClaim.mockResolvedValue(round());
    const res = await drainCatchupRounds("acct-1", OWNER, "sync.catchup_failed");

    expect(bulkCatchupClaim).toHaveBeenCalledTimes(6);
    expect(res).toMatchObject({ rounds: 6, overflowed: true });
  });

  it("stops at the wall-clock budget, before the round cap", async () => {
    // The budget is what keeps a big backlog under Safari's fetch wall.
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    bulkCatchupClaim.mockImplementation(async () => {
      now += 7_000;
      return round();
    });

    const res = await drainCatchupRounds("acct-1", OWNER, "sync.catchup_failed");

    expect(res.rounds).toBe(2);
    expect(bulkCatchupClaim).toHaveBeenCalledTimes(2);
  });

  it("sums every counter across rounds", async () => {
    bulkCatchupClaim
      .mockResolvedValueOnce(round({ scanned: 5, inserted: 4, ai_pending: 1, fetch_failed: 1 }))
      .mockResolvedValueOnce(
        round({ scanned: 3, inserted: 3, ai_pending: 2, fetch_failed: 0, overflowed: false }),
      );

    await expect(drainCatchupRounds("acct-1", OWNER, "k")).resolves.toEqual({
      scanned: 8,
      inserted: 7,
      ai_pending: 3,
      fetch_failed: 1,
      overflowed: false,
      rounds: 2,
    });
  });

  it("reports overflow from the LAST round, not from any round", async () => {
    // The caller uses it to decide whether to keep draining, so a stale
    // true would loop on a queue that is already clear.
    bulkCatchupClaim
      .mockResolvedValueOnce(round({ overflowed: true }))
      .mockResolvedValueOnce(round({ overflowed: false }));
    expect((await drainCatchupRounds("acct-1", OWNER, "k")).overflowed).toBe(false);
  });

  it("logs and returns what it has when a round throws", async () => {
    bulkCatchupClaim
      .mockResolvedValueOnce(round({ scanned: 4, inserted: 4 }))
      .mockRejectedValueOnce(new Error("claim deadlock"));

    const res = await drainCatchupRounds("acct-1", OWNER, "sync.catchup_failed");

    // The failed round is not counted — nothing was claimed in it.
    expect(res).toMatchObject({ rounds: 1, scanned: 4 });
    expect(logError).toHaveBeenCalledWith(
      "sync.catchup_failed",
      { account_id: "acct-1", user_id: OWNER },
      expect.any(Error),
    );
  });

  it("claims for the account AND the user, never the account alone", async () => {
    bulkCatchupClaim.mockResolvedValue(round({ overflowed: false }));
    await drainCatchupRounds("acct-1", OWNER, "k");
    expect(bulkCatchupClaim).toHaveBeenCalledWith("acct-1", OWNER);
  });
});

describe("ianaTz", () => {
  it("accepts the timezone spellings a schedule can carry", () => {
    for (const tz of ["UTC", "America/New_York", "Etc/GMT+5", "America/Argentina/Buenos_Aires"]) {
      expect(ianaTz.safeParse(tz).success, tz).toBe(true);
    }
  });

  it("rejects an empty, oversize or punctuated value", () => {
    // It reaches a cron expression and a Date formatter, so the character
    // set is deliberately narrow.
    for (const tz of ["", "x".repeat(65), "America/New York", "'; DROP", "UTC\n"]) {
      expect(ianaTz.safeParse(tz).success, JSON.stringify(tz)).toBe(false);
    }
  });
});
