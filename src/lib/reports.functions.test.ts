// src/lib/reports.functions.ts — the 90-day inbox report. One `createServerFn`
// on the request-scoped client, so tenant isolation here is RLS on
// `context.supabase` alone; the tests below pin the paging window, the
// aggregation and the label fallbacks.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));

import { getInboxReport, type InboxReport } from "./reports.functions";

const USER = "user-1";
const FOLDER = "aaaaaaaa-1111-4111-8111-111111111111";
const GONE_FOLDER = "bbbbbbbb-2222-4222-8222-222222222222";
const NOW = "2026-05-10T12:00:00.000Z";

/** Call the stubbed server fn with a request context. The real
 *  `createServerFn` signature has no `context` slot — only the stub honors
 *  one, the same trick `impersonate` uses. */
const runReport = (): Promise<InboxReport> =>
  (getInboxReport as unknown as (a: { context: Record<string, unknown> }) => Promise<InboxReport>)({
    context: { supabase: fake.supabaseAdmin, userId: USER },
  });

beforeEach(() => {
  fake.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

/** The four rows every aggregation test shares, plus two unusable ones. */
function seedEmails() {
  fake.seed("emails", [
    {
      id: "e1",
      user_id: USER,
      from_addr: "Jane Roe <JANE@ACME.test>",
      received_at: "2026-05-10T09:00:00Z",
      folder_id: FOLDER,
      is_read: false,
      has_attachment: true,
    },
    {
      id: "e2",
      user_id: USER,
      from_addr: "jane@acme.test",
      received_at: "2026-05-05T15:00:00Z",
      folder_id: FOLDER,
      is_read: true,
      has_attachment: false,
    },
    {
      id: "e3",
      user_id: USER,
      from_addr: "bob@other.test",
      received_at: "2026-04-20T00:00:00Z",
      folder_id: null,
      is_read: true,
      has_attachment: false,
    },
    {
      id: "e4",
      user_id: USER,
      from_addr: "bob@other.test",
      received_at: "2026-03-01T00:00:00Z",
      folder_id: GONE_FOLDER,
      is_read: true,
      has_attachment: false,
    },
  ]);
  fake.seed("folders", [{ id: FOLDER, user_id: USER, name: "Invoices", color: "#ff0000" }]);
}

describe("getInboxReport", () => {
  it("reads a 90-day window through the request-scoped client and writes nothing", async () => {
    // RLS-RELIANCE: this fn adds no `user_id` filter of its own — isolation is
    // RLS on `context.supabase`, proven in the DB-backed integration suite.
    // Pinned so a move to the service-role client can't pass silently.
    await runReport();

    const read = fake.calls.selects.find((s) => s.table === "emails")!;
    expect(read.filters).toStrictEqual([
      { op: "gte", col: "received_at", value: "2026-02-09T12:00:00.000Z", extra: undefined },
    ]);
    expect(writeCount(fake)).toBe(0);
  });

  // CHARACTERIZATION(reports-topsenders-address-only): the select omits
  // `from_name`, so `parseSender`'s display-name branch is dead and topSenders
  // can only ever show an address. The plaintext column does not exist — only
  // `from_name_enc` — so the fix needs a decrypt pass, not a wider select.
  // Flip when fixed.
  it("never selects a sender display name, so topSenders is address-only", async () => {
    seedEmails();

    const res = await runReport();

    expect(fake.calls.selects.find((s) => s.table === "emails")!.columns).toBe(
      "from_addr,received_at,folder_id,is_read,has_attachment",
    );
    expect(res.topSenders).toStrictEqual([
      { sender: "jane@acme.test", count: 2 },
      { sender: "bob@other.test", count: 2 },
    ]);
  });

  it("pages 1000 rows at a time and stops on the first short page", async () => {
    fake.seed(
      "emails",
      Array.from({ length: 1003 }, (_, i) => ({
        id: `e${i}`,
        user_id: USER,
        from_addr: "sender@acme.test",
        received_at: "2026-05-01T00:00:00Z",
        folder_id: null,
        is_read: true,
        has_attachment: false,
      })),
    );

    const res = await runReport();

    // Two reads: rows 0-999 then 1000-1999. A repeated first window would
    // double-count into 2000, so the row total proves the offset advanced.
    expect(fake.calls.selects.filter((s) => s.table === "emails")).toHaveLength(2);
    expect(res.sampleSize).toBe(1003);
    expect(res.truncated).toBe(false);
  });

  it("keeps the pages it already read when a later page errors", async () => {
    fake.seed(
      "emails",
      Array.from({ length: 1500 }, (_, i) => ({
        id: `e${i}`,
        user_id: USER,
        from_addr: "sender@acme.test",
        received_at: "2026-05-01T00:00:00Z",
        folder_id: null,
        is_read: true,
        has_attachment: false,
      })),
    );
    let page = 0;
    fake.onSelect("emails", () => {
      page += 1;
      return page === 1 ? undefined : { message: "page 2 blocked" };
    });

    const res = await runReport();

    expect(res.sampleSize).toBe(1000);
    expect(res.truncated).toBe(false);
  });

  it("aggregates totals, histograms and the daily sparkline over the window", async () => {
    seedEmails();

    const res = await runReport();

    expect(res.windowDays).toBe(90);
    expect(res.totals).toStrictEqual({ d7: 2, d30: 3, d90: 4 });
    expect(res.avgPerDay30).toBe(0.1);
    expect(res.unread).toBe(1);
    expect(res.read).toBe(3);
    expect(res.withAttachments).toBe(1);

    // Sunday ×2 (e1, e4), Tuesday (e2), Monday (e3).
    expect(res.dowHistogram).toStrictEqual([2, 1, 1, 0, 0, 0, 0]);
    expect(res.busiestDow).toStrictEqual({ dow: 0, count: 2 });
    expect(res.hourHistogram[0]).toBe(2);
    expect(res.hourHistogram[9]).toBe(1);
    expect(res.hourHistogram[15]).toBe(1);
    expect(res.busiestHour).toStrictEqual({ hour: 0, count: 2 });

    // 30 pre-seeded days ending today, only the in-window rows counted.
    expect(res.daily).toHaveLength(30);
    expect(res.daily[0]!.date).toBe("2026-04-11");
    expect(res.daily[29]).toStrictEqual({ date: "2026-05-10", count: 1 });
    expect(res.daily.find((d) => d.date === "2026-05-05")).toStrictEqual({
      date: "2026-05-05",
      count: 1,
    });
    expect(res.daily.reduce((s, d) => s + d.count, 0)).toBe(3);
  });

  it("ranks domains by volume, unwrapping angle-bracketed addresses", async () => {
    seedEmails();

    const res = await runReport();

    expect(res.topDomains).toStrictEqual([
      { domain: "acme.test", count: 2 },
      { domain: "other.test", count: 2 },
    ]);
  });

  it("labels both a null folder and a folder that no longer exists 'Uncategorized'", async () => {
    seedEmails();

    const res = await runReport();

    expect(res.folderBreakdown).toStrictEqual([
      { folder_id: FOLDER, name: "Invoices", color: "#ff0000", count: 2 },
      { folder_id: null, name: "Uncategorized", color: "#71717a", count: 1 },
      { folder_id: GONE_FOLDER, name: "Uncategorized", color: "#71717a", count: 1 },
    ]);
  });

  it("ignores rows with a missing or unparseable timestamp while still counting them as sampled", async () => {
    fake.seed("emails", [
      {
        id: "e-null",
        user_id: USER,
        from_addr: "a@acme.test",
        received_at: null,
        folder_id: null,
        is_read: false,
        has_attachment: false,
      },
      {
        id: "e-bad",
        user_id: USER,
        from_addr: "b@acme.test",
        received_at: "not-a-date",
        folder_id: null,
        is_read: false,
        has_attachment: false,
      },
    ]);

    const res = await runReport();

    expect(res.unread).toBe(0);
    expect(res.read).toBe(0);
    expect(res.topSenders).toStrictEqual([]);
    // Sample size (and therefore the 90-day total) counts every fetched row,
    // usable or not.
    expect(res.sampleSize).toBe(2);
    expect(res.totals.d90).toBe(2);
  });

  it("reports an empty inbox without a busiest day or hour", async () => {
    const res = await runReport();

    expect(res.totals).toStrictEqual({ d7: 0, d30: 0, d90: 0 });
    expect(res.avgPerDay30).toBe(0);
    expect(res.busiestDow).toBeNull();
    expect(res.busiestHour).toBeNull();
    expect(res.topDomains).toStrictEqual([]);
    expect(res.folderBreakdown).toStrictEqual([]);
    expect(res.daily.every((d) => d.count === 0)).toBe(true);
    // No folder ids to resolve, so the folders table is never read.
    expect(fake.calls.selects.map((s) => s.table)).toStrictEqual(["emails"]);
  });
});
