// The "iPhone contacts" settings server fns. Everything here exists to move
// the address-book CTag and the per-contact ETags, so the contracts worth
// protecting are all about what makes an iPhone re-fetch:
//
//   * every setting write bumps resync_nonce (read-then-upsert on user_id),
//     because the nonce is a term of the book CTag;
//   * the contacts.updated_at sweep runs ONLY when include_summary_in_notes
//     actually flips — it rewrites every summarised contact, so running it
//     on an unrelated toggle would push the whole book to Google as well;
//   * the sweep is scoped to the caller and to rows that actually have a
//     stored summary, and reports how many rows it touched.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, writesTo } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { callWithRlsClient } from "@/lib/__fixtures__/rls-server-fn";

const fake = makeSupabaseFake({ applyWrites: true });

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import {
  bumpResyncNonce,
  getCardDavSettings,
  updateCardDavSettings,
  resyncSummaryContacts,
  forceCarddavResync,
} from "./settings.functions";

const OTHER = "other-user-2";
const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-08-01T09:30:00.000Z");

function seedSettings(row: {
  user_id?: string;
  resync_nonce?: number;
  group_name_style?: string;
  include_summary_in_notes?: boolean;
  use_company_logo_fallback?: boolean;
}): void {
  fake.seed("carddav_settings", [{ user_id: TEST_USER, ...row }]);
}

/** Contacts whose relationship_summary_enc is non-null are the ones the
 * summary sweep is supposed to touch. */
function seedSummarisedContacts(): void {
  fake.seed("contacts", [
    { id: C1, user_id: TEST_USER, relationship_summary_enc: "enc-a", updated_at: "2026-01-01" },
    { id: C2, user_id: TEST_USER, relationship_summary_enc: null, updated_at: "2026-01-01" },
    { id: C3, user_id: OTHER, relationship_summary_enc: "enc-c", updated_at: "2026-01-01" },
  ]);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  fake.reset();
  fake.seed("carddav_settings", []);
  fake.seed("contacts", []);
});

describe("getCardDavSettings", () => {
  it("returns the stored row", async () => {
    seedSettings({
      group_name_style: "path_dash",
      include_summary_in_notes: false,
      use_company_logo_fallback: false,
    });
    const settings = await callWithRlsClient(getCardDavSettings, { fake })();
    expect(settings).toStrictEqual({
      group_name_style: "path_dash",
      include_summary_in_notes: false,
      use_company_logo_fallback: false,
    });
  });

  it("falls back to the feature-on defaults when no row exists yet", async () => {
    // A row is only written on the first update, so a fresh account must
    // still light up the nested-path names, the summary NOTE and the logo
    // fallback.
    const settings = await callWithRlsClient(getCardDavSettings, { fake })();
    expect(settings).toStrictEqual({
      group_name_style: "path_slash",
      include_summary_in_notes: true,
      use_company_logo_fallback: true,
    });
  });

  it("coerces an unrecognised stored style back to path_slash", async () => {
    seedSettings({ group_name_style: "whatever-a-migration-left" });
    const settings = await callWithRlsClient(getCardDavSettings, { fake })();
    expect(settings.group_name_style).toBe("path_slash");
  });

  it("surfaces a read failure instead of silently serving defaults", async () => {
    fake.onSelect("carddav_settings", () => ({ message: "settings read failed" }));
    await expect(callWithRlsClient(getCardDavSettings, { fake })()).rejects.toThrow(
      "settings read failed",
    );
  });
});

describe("updateCardDavSettings", () => {
  it("bumps resync_nonce and writes only the keys the caller sent", async () => {
    seedSettings({ resync_nonce: 4, include_summary_in_notes: true });

    await callWithRlsClient(updateCardDavSettings, { fake })({
      data: { group_name_style: "leaf" },
    });

    const upserts = writesTo(fake, "upserts", "carddav_settings");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.payload).toStrictEqual({
      user_id: TEST_USER,
      resync_nonce: 5,
      group_name_style: "leaf",
    });
    expect(upserts[0]!.options).toEqual({ onConflict: "user_id" });
  });

  it("starts the nonce at 1 for an account with no settings row", async () => {
    await callWithRlsClient(updateCardDavSettings, { fake })({
      data: { use_company_logo_fallback: false },
    });
    const upserts = writesTo(fake, "upserts", "carddav_settings");
    expect(upserts[0]!.payload).toStrictEqual({
      user_id: TEST_USER,
      resync_nonce: 1,
      use_company_logo_fallback: false,
    });
  });

  it("rejects an unknown group-name style before writing anything", async () => {
    await expect(
      callWithRlsClient(updateCardDavSettings, { fake })({
        data: { group_name_style: "spiral" as never },
      }),
    ).rejects.toThrow();
    expect(writesTo(fake, "upserts", "carddav_settings")).toHaveLength(0);
  });

  it("touches every summarised contact when include_summary_in_notes flips", async () => {
    // The sweep is what makes contacts summarised before the feature shipped
    // re-sync at all: nothing else has moved their updated_at since.
    seedSettings({ resync_nonce: 0, include_summary_in_notes: true });
    seedSummarisedContacts();

    await callWithRlsClient(updateCardDavSettings, { fake })({
      data: { include_summary_in_notes: false },
    });

    const touches = writesTo(fake, "updates", "contacts");
    expect(touches).toHaveLength(1);
    expect(touches[0]!.payload).toStrictEqual({ updated_at: NOW.toISOString() });
    expect(touches[0]!.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
        { op: "not", col: "relationship_summary_enc", value: null, extra: "is" },
      ]),
    );
    // Only the caller's summarised contact moved.
    const moved = fake
      .rows("contacts")
      .filter((r) => r.updated_at === NOW.toISOString())
      .map((r) => r.id);
    expect(moved).toEqual([C1]);
  });

  it("does not touch contacts when the toggle is re-sent with the same value", async () => {
    seedSettings({ resync_nonce: 0, include_summary_in_notes: true });
    seedSummarisedContacts();

    await callWithRlsClient(updateCardDavSettings, { fake })({
      data: { include_summary_in_notes: true },
    });

    expect(writesTo(fake, "updates", "contacts")).toHaveLength(0);
  });

  it("treats a missing stored value as 'on', so turning it off still sweeps", async () => {
    // getCardDavSettings defaults the toggle to true; the flip check has to
    // use the same default or the very first "turn it off" would no-op.
    fake.seed("carddav_settings", []);
    seedSummarisedContacts();

    await callWithRlsClient(updateCardDavSettings, { fake })({
      data: { include_summary_in_notes: false },
    });
    expect(writesTo(fake, "updates", "contacts")).toHaveLength(1);
  });

  it("does not sweep contacts for an unrelated toggle", async () => {
    seedSettings({ resync_nonce: 0, include_summary_in_notes: true });
    seedSummarisedContacts();

    await callWithRlsClient(updateCardDavSettings, { fake })({
      data: { use_company_logo_fallback: false },
    });
    expect(writesTo(fake, "updates", "contacts")).toHaveLength(0);
  });

  it("throws on a failing upsert without sweeping contacts", async () => {
    seedSettings({ resync_nonce: 0, include_summary_in_notes: true });
    seedSummarisedContacts();
    fake.onUpsert("carddav_settings", () => ({ message: "settings write failed" }));

    await expect(
      callWithRlsClient(updateCardDavSettings, { fake })({
        data: { include_summary_in_notes: false },
      }),
    ).rejects.toThrow("settings write failed");
    expect(writesTo(fake, "updates", "contacts")).toHaveLength(0);
  });
});

describe("resyncSummaryContacts", () => {
  it("bumps the nonce and reports how many summarised contacts it touched", async () => {
    seedSettings({ resync_nonce: 2 });
    seedSummarisedContacts();

    const result = await callWithRlsClient(resyncSummaryContacts, { fake })();

    // The count comes from the returning `select("id")` on the update, so it
    // is the number of rows the DB actually moved, not an estimate.
    expect(result).toStrictEqual({ ok: true, count: 1 });
    expect(writesTo(fake, "upserts", "carddav_settings")[0]!.payload).toStrictEqual({
      user_id: TEST_USER,
      resync_nonce: 3,
    });
    const moved = fake
      .rows("contacts")
      .filter((r) => r.updated_at === NOW.toISOString())
      .map((r) => r.id);
    expect(moved).toEqual([C1]);
  });

  it("reports zero when nothing carries a stored summary", async () => {
    seedSettings({ resync_nonce: 0 });
    fake.seed("contacts", [
      { id: C1, user_id: TEST_USER, relationship_summary_enc: null, updated_at: "2026-01-01" },
    ]);
    const result = await callWithRlsClient(resyncSummaryContacts, { fake })();
    expect(result).toStrictEqual({ ok: true, count: 0 });
  });

  it("throws when the sweep fails", async () => {
    seedSettings({ resync_nonce: 0 });
    seedSummarisedContacts();
    fake.onUpdate("contacts", () => ({ message: "sweep failed" }));
    await expect(callWithRlsClient(resyncSummaryContacts, { fake })()).rejects.toThrow(
      "sweep failed",
    );
  });
});

describe("forceCarddavResync / bumpResyncNonce", () => {
  it("increments the stored nonce and returns the new value", async () => {
    seedSettings({ resync_nonce: 7 });
    const result = await callWithRlsClient(forceCarddavResync, { fake })();
    expect(result).toStrictEqual({ ok: true, resync_nonce: 8 });
    expect(writesTo(fake, "upserts", "carddav_settings")[0]!.payload).toStrictEqual({
      user_id: TEST_USER,
      resync_nonce: 8,
    });
  });

  it("bumpResyncNonce writes nothing beyond the nonce and throws on failure", async () => {
    // Other modules (label merges, photo-priority writes) call this directly
    // and must not clobber the user's display preferences on the way past.
    seedSettings({ resync_nonce: 1, group_name_style: "leaf" });
    await expect(bumpResyncNonce(fake.client as never, TEST_USER)).resolves.toBe(2);
    expect(fake.rows("carddav_settings")[0]).toMatchObject({
      resync_nonce: 2,
      group_name_style: "leaf",
    });

    fake.onUpsert("carddav_settings", () => ({ message: "nonce write failed" }));
    await expect(bumpResyncNonce(fake.client as never, TEST_USER)).rejects.toThrow(
      "nonce write failed",
    );
  });
});
