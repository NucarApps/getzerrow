// Digest action (rules upgrade, task 9). Contracts protected:
//
//   * the digest action inserts one reference row per email (bucket
//     from config, default daily) — inline, no queue,
//   * the sender fires only at the user's local digest hour (weekly
//     additionally requires the configured weekday), with an invalid
//     timezone falling back to UTC,
//   * a due digest groups by folder, sends ONE email via the mailbox
//     the items live in, and stamps sent_at on exactly those rows,
//   * AI is garnish — a failing summarizer never blocks the send.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

const sendMessage = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../gmail.server", () => ({
  modifyMessage: async () => ({}),
  sendMessage: (...args: unknown[]) => sendMessage(...args),
  createDraft: async () => ({}),
}));

const getEmailsDecrypted = vi.fn();
vi.mock("./encrypted-reader", () => ({
  getEmailsDecrypted: (ids: string[]) => getEmailsDecrypted(ids),
}));
vi.mock("@/lib/log.server", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import { dispatchFolderActions, type FolderActionRow } from "./action-dispatch";

const { sendDigests, dueBuckets, localClock } = await import("./digest.server");

// 08:00 UTC on Monday 2026-07-20.
const MONDAY_8AM_UTC = new Date("2026-07-20T08:00:00Z");

beforeEach(() => {
  fake.reset();
  sendMessage.mockClear();
  getEmailsDecrypted.mockReset();
});

describe("digest dispatch", () => {
  it("inserts a digest_items row with the configured bucket", async () => {
    const action: FolderActionRow = {
      id: "act-d",
      action_type: "digest",
      label_id: null,
      move_to_folder_id: null,
      delay_minutes: 0,
      digest_bucket: "weekly",
    };
    const { outcomes } = await dispatchFolderActions({
      actions: [action],
      parsed: { raw_labels: ["INBOX"] },
      inInbox: true,
      persistFlags: true,
      emailRowId: "e1",
      userId: "user-1",
    });
    expect(outcomes[0]).toMatchObject({ action_type: "digest", status: "applied" });
    const inserts = fake.calls.inserts.filter((i) => i.table === "digest_items");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toMatchObject({
      user_id: "user-1",
      email_id: "e1",
      bucket: "weekly",
    });
  });
});

describe("digest timing", () => {
  it("daily is due only at the configured local hour; weekly needs the weekday too", () => {
    const s = { digest_hour: 8, digest_timezone: "UTC", digest_weekly_dow: 1 };
    expect(dueBuckets(MONDAY_8AM_UTC, s)).toEqual(["daily", "weekly"]);
    expect(dueBuckets(new Date("2026-07-21T08:00:00Z"), s)).toEqual(["daily"]); // Tuesday
    expect(dueBuckets(new Date("2026-07-20T09:00:00Z"), s)).toEqual([]); // wrong hour
  });

  it("an invalid timezone falls back to UTC instead of throwing", () => {
    expect(localClock(MONDAY_8AM_UTC, "Not/AZone").hour).toBe(8);
  });
});

describe("digest sending", () => {
  function seed() {
    fake.seed("digest_items", [
      { id: "d1", user_id: "user-1", email_id: "e1", bucket: "daily", sent_at: null },
      { id: "d2", user_id: "user-1", email_id: "e2", bucket: "daily", sent_at: null },
      { id: "d3", user_id: "user-1", email_id: "e0", bucket: "daily", sent_at: "2026-07-19" },
    ]);
    fake.seed("user_settings", [
      { user_id: "user-1", digest_hour: 8, digest_timezone: "UTC", digest_weekly_dow: 1 },
    ]);
    fake.seed("folders", [{ id: "f-news", name: "Newsletters" }]);
    fake.seed("gmail_accounts", [{ id: "acc-1", email_address: "taylor@nucar.com" }]);
    getEmailsDecrypted.mockResolvedValue({
      rows: [
        {
          id: "e1",
          gmail_account_id: "acc-1",
          folder_id: "f-news",
          from_name: "Lenny",
          from_addr: "lenny@substack.com",
          subject: "Discovery habits",
        },
        {
          id: "e2",
          gmail_account_id: "acc-1",
          folder_id: null,
          from_name: null,
          from_addr: "a@x.com",
          subject: null,
        },
      ],
      error: null,
    });
  }

  it("sends one grouped digest at digest time and stamps sent_at", async () => {
    seed();
    const r = await sendDigests(MONDAY_8AM_UTC, async () => "Two things today.");
    expect(r).toMatchObject({ users: 1, sent: 1, items: 2 });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [accountId, to, subject, body] = sendMessage.mock.calls[0] as string[];
    expect(accountId).toBe("acc-1");
    expect(to).toBe("taylor@nucar.com");
    expect(subject).toContain("daily digest — 2 emails");
    expect(body).toContain("Two things today.");
    expect(body).toContain("Newsletters (1)");
    expect(body).toContain("Lenny — Discovery habits");
    expect(body).toContain("Inbox (1)");
    const marks = fake.calls.updates.filter((u) => u.table === "digest_items");
    expect(marks).toHaveLength(1);
    expect(marks[0].filters).toEqual([{ op: "in", col: "id", value: ["d1", "d2"] }]);
  });

  it("outside digest time nothing sends", async () => {
    seed();
    const r = await sendDigests(new Date("2026-07-20T11:00:00Z"), async () => "nope");
    expect(r.sent).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("a failing AI summarizer still sends the plain listing", async () => {
    seed();
    const r = await sendDigests(MONDAY_8AM_UTC, async () => {
      throw new Error("model down");
    });
    expect(r.sent).toBe(1);
    const body = (sendMessage.mock.calls[0] as string[])[3];
    expect(body).toContain("Lenny — Discovery habits");
  });
});
