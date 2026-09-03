// Card analytics (card-analytics.functions.ts).
//
// logCardEvent is the second UNAUTHENTICATED public write on the cards
// surface: it inserts a row of caller-supplied text against a card it looks
// up by handle. The contract pinned here is that an unknown handle writes
// nothing, and that a known one writes exactly the columns below — nothing
// the caller sends chooses the owner.
//
// getMyCardAnalytics is pure aggregation over one owner's rows; the day
// bucketing, the topLinks cap and the recent cap are asserted against a
// frozen clock.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", async () => {
  const { mockSupabaseAdmin } = await import("@/lib/__fixtures__/supabase-fake");
  return { supabaseAdmin: mockSupabaseAdmin(() => fake) };
});

import { logCardEvent, getMyCardAnalytics } from "./card-analytics.functions";

const OWNER = "owner-user-1";
const CARD_ID = "card-1";
const NOW = "2026-09-03T12:00:00.000Z";

function seedCard() {
  fake.seed("my_cards", [{ id: CARD_ID, user_id: OWNER, handle: "jane" }]);
}

type EventSeed = {
  id: string;
  event_type: string;
  created_at: string;
  link_kind?: string | null;
  link_url?: string | null;
  referrer?: string | null;
  owner_user_id?: string;
};
function seedEvents(events: EventSeed[]) {
  fake.seed(
    "card_events",
    events.map((e) => ({
      id: e.id,
      owner_user_id: e.owner_user_id ?? TEST_USER,
      card_id: CARD_ID,
      handle: "jane",
      event_type: e.event_type,
      link_kind: e.link_kind ?? null,
      link_url: e.link_url ?? null,
      referrer: e.referrer ?? null,
      created_at: e.created_at,
    })),
  );
}

beforeEach(() => {
  fake.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("logCardEvent", () => {
  it("records a view against the card's owner with every column set", async () => {
    seedCard();
    expect(await logCardEvent({ data: { handle: "jane", event_type: "view" } })).toStrictEqual({
      ok: true,
    });
    expect(fake.calls.inserts).toHaveLength(1);
    expect(fake.calls.inserts[0]?.table).toBe("card_events");
    expect(fake.calls.inserts[0]?.payload).toStrictEqual({
      card_id: CARD_ID,
      // Taken from the card row, never from the caller.
      owner_user_id: OWNER,
      handle: "jane",
      event_type: "view",
      link_kind: null,
      link_url: null,
      referrer: null,
      // Never recorded: no user agent is read from the request.
      user_agent: null,
    });
  });

  it("records the link a click went to", async () => {
    seedCard();
    await logCardEvent({
      data: {
        handle: "jane",
        event_type: "link_click",
        link_kind: "website",
        link_url: "https://acme.test",
        referrer: "https://news.test/post",
      },
    });
    expect(fake.calls.inserts[0]?.payload).toMatchObject({
      event_type: "link_click",
      link_kind: "website",
      link_url: "https://acme.test",
      referrer: "https://news.test/post",
    });
  });

  it("writes nothing for an unknown handle and says so", async () => {
    fake.seed("my_cards", []);
    expect(await logCardEvent({ data: { handle: "nobody", event_type: "view" } })).toStrictEqual({
      ok: false,
    });
    expect(writeCount(fake)).toBe(0);
  });

  it("looks the card up by the lower-cased handle", async () => {
    seedCard();
    await logCardEvent({ data: { handle: "jane", event_type: "share" } });
    expect(fake.calls.selects[0]?.filters).toStrictEqual([
      { op: "eq", col: "handle", value: "jane", extra: undefined },
    ]);
  });

  it.each([
    ["an unknown event type", { handle: "jane", event_type: "purchase" }],
    ["an unknown link kind", { handle: "jane", event_type: "link_click", link_kind: "sms" }],
    [
      "a link URL over 500 characters",
      { handle: "jane", event_type: "link_click", link_url: "x".repeat(501) },
    ],
    [
      "a referrer over 500 characters",
      { handle: "jane", event_type: "view", referrer: "x".repeat(501) },
    ],
    ["a malformed handle", { handle: "NO", event_type: "view" }],
  ])("refuses %s at the validator, before any read", async (_label, data) => {
    seedCard();
    await expect(logCardEvent({ data })).rejects.toThrow();
    expect(fake.calls.selects).toEqual([]);
    expect(writeCount(fake)).toBe(0);
  });
});

describe("getMyCardAnalytics", () => {
  it("reads only the caller's own events, from the requested window, newest first", async () => {
    seedEvents([
      { id: "e-mine", event_type: "view", created_at: "2026-09-03T09:00:00.000Z" },
      {
        id: "e-theirs",
        event_type: "view",
        created_at: "2026-09-03T09:00:00.000Z",
        owner_user_id: OWNER,
      },
    ]);

    const summary = await getMyCardAnalytics({ data: { days: 7 } });
    expect(summary.totals.view).toBe(1);
    expect(summary.recent.map((r) => r.id)).toStrictEqual(["e-mine"]);
    expect(fake.calls.selects[0]).toMatchObject({
      table: "card_events",
      limit: 5000,
      filters: [
        { op: "eq", col: "owner_user_id", value: TEST_USER, extra: undefined },
        // 7 days back from the frozen clock, to the millisecond.
        { op: "gte", col: "created_at", value: "2026-08-27T12:00:00.000Z", extra: undefined },
      ],
    });
  });

  it("defaults to a 30-day window and echoes it back", async () => {
    seedEvents([]);
    const summary = await getMyCardAnalytics();
    expect(summary.rangeDays).toBe(30);
    expect(summary.daily).toHaveLength(30);
    expect(summary.daily[0]?.day).toBe("2026-08-05");
    expect(summary.daily[29]?.day).toBe("2026-09-03");
  });

  it("prefills every day in the window with zeroes, oldest first", async () => {
    seedEvents([]);
    const summary = await getMyCardAnalytics({ data: { days: 3 } });
    expect(summary.daily).toStrictEqual([
      { day: "2026-09-01", views: 0, clicks: 0, downloads: 0, shares: 0 },
      { day: "2026-09-02", views: 0, clicks: 0, downloads: 0, shares: 0 },
      { day: "2026-09-03", views: 0, clicks: 0, downloads: 0, shares: 0 },
    ]);
    expect(summary.totals).toStrictEqual({
      view: 0,
      link_click: 0,
      vcard_download: 0,
      share: 0,
      lead: 0,
    });
    expect(summary.topLinks).toStrictEqual([]);
  });

  it("counts each event type into its total and its day's bucket", async () => {
    seedEvents([
      { id: "1", event_type: "view", created_at: "2026-09-03T01:00:00.000Z" },
      { id: "2", event_type: "view", created_at: "2026-09-03T02:00:00.000Z" },
      {
        id: "3",
        event_type: "link_click",
        created_at: "2026-09-03T03:00:00.000Z",
        link_kind: "website",
        link_url: "https://acme.test",
      },
      { id: "4", event_type: "vcard_download", created_at: "2026-09-02T04:00:00.000Z" },
      { id: "5", event_type: "share", created_at: "2026-09-02T05:00:00.000Z" },
      { id: "6", event_type: "lead", created_at: "2026-09-02T06:00:00.000Z" },
    ]);

    const summary = await getMyCardAnalytics({ data: { days: 3 } });
    expect(summary.totals).toStrictEqual({
      view: 2,
      link_click: 1,
      vcard_download: 1,
      share: 1,
      lead: 1,
    });
    expect(summary.daily).toStrictEqual([
      { day: "2026-09-01", views: 0, clicks: 0, downloads: 0, shares: 0 },
      // A lead is counted in the totals but has no column in the daily row.
      { day: "2026-09-02", views: 0, clicks: 0, downloads: 1, shares: 1 },
      { day: "2026-09-03", views: 2, clicks: 1, downloads: 0, shares: 0 },
    ]);
  });

  it("ranks clicked links by count and keeps only the top eight", async () => {
    // Ten distinct links, each clicked (10 - i) times.
    const events: EventSeed[] = [];
    for (let i = 0; i < 10; i++) {
      for (let n = 0; n < 10 - i; n++) {
        events.push({
          id: `e-${i}-${n}`,
          event_type: "link_click",
          created_at: "2026-09-03T01:00:00.000Z",
          link_kind: "website",
          link_url: `https://link-${i}.test`,
        });
      }
    }
    seedEvents(events);

    const { topLinks } = await getMyCardAnalytics({ data: { days: 3 } });
    expect(topLinks).toHaveLength(8);
    expect(topLinks[0]).toStrictEqual({
      link_kind: "website",
      link_url: "https://link-0.test",
      count: 10,
    });
    expect(topLinks[7]?.count).toBe(3);
    expect(topLinks.map((l) => l.link_url)).not.toContain("https://link-9.test");
  });

  it("groups link clicks by kind AND url, defaulting a missing kind to other", async () => {
    seedEvents([
      {
        id: "1",
        event_type: "link_click",
        created_at: "2026-09-03T01:00:00.000Z",
        link_kind: null,
        link_url: null,
      },
      {
        id: "2",
        event_type: "link_click",
        created_at: "2026-09-03T02:00:00.000Z",
        link_kind: null,
        link_url: null,
      },
      {
        id: "3",
        event_type: "link_click",
        created_at: "2026-09-03T03:00:00.000Z",
        link_kind: "email",
        link_url: "mailto:jane@acme.test",
      },
    ]);

    const { topLinks } = await getMyCardAnalytics({ data: { days: 3 } });
    expect(topLinks).toStrictEqual([
      { link_kind: "other", link_url: null, count: 2 },
      { link_kind: "email", link_url: "mailto:jane@acme.test", count: 1 },
    ]);
  });

  it("returns at most twenty-five recent events, newest first", async () => {
    seedEvents(
      Array.from({ length: 30 }, (_, i) => ({
        id: `e-${String(i).padStart(2, "0")}`,
        event_type: "view",
        // i = 0 is the oldest.
        created_at: `2026-09-03T${String(i % 24).padStart(2, "0")}:${String(i).padStart(2, "0")}:00.000Z`,
      })),
    );

    const { recent, totals } = await getMyCardAnalytics({ data: { days: 3 } });
    expect(recent).toHaveLength(25);
    expect(totals.view).toBe(30);
    // Ordering is the query's `created_at desc`, preserved through the slice.
    const timestamps = recent.map((r) => r.created_at);
    expect([...timestamps].sort().reverse()).toStrictEqual(timestamps);
  });

  it("survives a failed read by reporting an empty summary", async () => {
    fake.onSelect("card_events", () => ({ message: "card_events unavailable" }));
    const summary = await getMyCardAnalytics({ data: { days: 2 } });
    expect(summary.recent).toStrictEqual([]);
    expect(summary.daily).toHaveLength(2);
  });

  it.each([0, 366, 1.5])("refuses a %s-day window", async (days) => {
    await expect(getMyCardAnalytics({ data: { days } })).rejects.toThrow();
  });

  // CHARACTERIZATION(card-analytics-daily-adds-out-of-window-day): the day
  // buckets are prefilled by calendar day but the query filters by a
  // timestamp exactly `days * 24h` ago, so an event from earlier on the
  // oldest day still passes the filter and, finding no prefilled bucket,
  // CREATES one — `daily` comes back with more entries than `rangeDays`.
  it("adds an extra day to `daily` for an event before the prefilled window", async () => {
    seedEvents([
      // After `since` (2026-09-02T12:00Z) but on the day before "today".
      { id: "early", event_type: "view", created_at: "2026-09-02T18:00:00.000Z" },
    ]);

    const summary = await getMyCardAnalytics({ data: { days: 1 } });
    expect(summary.rangeDays).toBe(1);
    expect(summary.daily.map((d) => d.day)).toStrictEqual(["2026-09-02", "2026-09-03"]);
    // What it should be, once the window and the buckets agree:
    expect(summary.daily).not.toHaveLength(1);
  });
});
