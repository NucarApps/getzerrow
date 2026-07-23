// Tests for the destructive contact-dedup server functions and the background
// scan core (src/lib/contacts/dedup.functions.ts). The highest-value cases here
// are the *fail-recovery* ones: the merge path documents (dedup.functions.ts,
// around the group-membership transfer) that "the insert must succeed before the
// delete — otherwise a failed transfer followed by an unconditional delete
// silently erases the user's labels." These tests inject a single write failure
// and assert the compensating behaviour: the function throws BEFORE any
// destructive `contacts` delete runs.
//
// Harness mirrors gmail/move.functions.test.ts: @tanstack/react-start is stubbed
// so each createServerFn becomes a plain callable whose zod validator still runs;
// the Supabase admin client is the shared chainable fake.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

// -- Harness: createServerFn chain becomes a plain callable ------------------
vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));

// -- DB: shared chainable fake (deferred property access so the hoisted factory
// never touches `fake` before its initializer runs). ------------------------
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

// Subgroup reconciliation is a DB-heavy side effect; stub it and assert calls.
const reconcileAutoParentsForContacts = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./auto-company-subgroups.functions", () => ({
  reconcileAutoParentsForContacts: (...args: unknown[]) => reconcileAutoParentsForContacts(...args),
}));

// Logging is a no-op in tests.
vi.mock("@/lib/log.server", () => ({ logInfo: vi.fn(), logError: vi.fn() }));

import {
  mergeContactDuplicate,
  dismissContactDuplicate,
  mergeContactsManual,
  scanContactDuplicatesImpl,
} from "./dedup.functions";

const USER = "test-user-1"; // matches server-fn-stub TEST_USER
const SUGGESTION_ID = "11111111-1111-4111-8111-111111111111";
const PRIMARY = "aaaaaaaa-1111-4111-8111-111111111111";
const DUP = "bbbbbbbb-2222-4222-8222-222222222222";

/** Seed a pending suggestion row (as read via context.supabase). */
function seedSuggestion(overrides: Record<string, unknown> = {}) {
  fake.seed("contact_duplicate_suggestions", [
    {
      id: SUGGESTION_ID,
      user_id: USER,
      primary_contact_id: PRIMARY,
      duplicate_contact_ids: [DUP],
      status: "pending",
      ...overrides,
    },
  ]);
}

const ctx = { context: { supabase: fake.supabaseAdmin } };

beforeEach(() => {
  fake.reset();
  reconcileAutoParentsForContacts.mockClear();
});

/* -------------------------------------------------------------------------- */
/* mergeContactDuplicate — status guards                                       */
/* -------------------------------------------------------------------------- */

describe("mergeContactDuplicate — guards", () => {
  it("rejects when the suggestion does not exist", async () => {
    // no seed → maybeSingle returns null
    await expect(
      mergeContactDuplicate({ data: { suggestionId: SUGGESTION_ID }, ...ctx }),
    ).rejects.toThrow("Suggestion not found");
  });

  it("rejects a suggestion that is already resolved", async () => {
    seedSuggestion({ status: "merged" });
    await expect(
      mergeContactDuplicate({ data: { suggestionId: SUGGESTION_ID }, ...ctx }),
    ).rejects.toThrow("Already resolved");
  });

  it("rejects when there are no duplicates left to merge", async () => {
    // duplicate_contact_ids contains only the primary → filtered to empty
    seedSuggestion({ duplicate_contact_ids: [PRIMARY] });
    await expect(
      mergeContactDuplicate({ data: { suggestionId: SUGGESTION_ID }, ...ctx }),
    ).rejects.toThrow("No duplicates to merge");
  });
});

/* -------------------------------------------------------------------------- */
/* mergeContactDuplicate — fail-recovery (the data-loss invariant)             */
/* -------------------------------------------------------------------------- */

describe("mergeContactDuplicate — fail-recovery ordering", () => {
  function contactsDeletes() {
    return fake.calls.deletes.filter((d) => d.table === "contacts");
  }

  it("aborts before deleting contacts when the membership transfer (upsert) fails", async () => {
    seedSuggestion();
    fake.seed("contact_group_members", [{ group_id: "g1", contact_id: DUP, user_id: USER }]);
    // Inject the failure that the code comment warns about.
    fake.onUpsert("contact_group_members", () => ({ message: "upsert boom" }));

    await expect(
      mergeContactDuplicate({ data: { suggestionId: SUGGESTION_ID }, ...ctx }),
    ).rejects.toThrow(/Failed to move group memberships during merge/);

    // The critical assertion: the duplicate contact row must NOT be deleted,
    // so the user's labels are recoverable.
    expect(contactsDeletes()).toHaveLength(0);
    // And the duplicate's memberships must not have been cleared either.
    expect(fake.calls.deletes.filter((d) => d.table === "contact_group_members")).toHaveLength(0);
  });

  it("aborts before deleting contacts when clearing duplicate memberships fails", async () => {
    seedSuggestion();
    fake.seed("contact_group_members", [{ group_id: "g1", contact_id: DUP, user_id: USER }]);
    // Upsert succeeds, the subsequent delete of duplicate memberships fails.
    fake.onDelete("contact_group_members", () => ({ message: "delete boom" }));

    await expect(
      mergeContactDuplicate({ data: { suggestionId: SUGGESTION_ID }, ...ctx }),
    ).rejects.toThrow(/Failed to clear duplicate memberships during merge/);

    expect(contactsDeletes()).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* mergeContactDuplicate — Google link repointing                              */
/* -------------------------------------------------------------------------- */

describe("mergeContactDuplicate — Google link collisions", () => {
  it("moves non-colliding links and skips links whose account already exists on the primary", async () => {
    seedSuggestion();
    // Primary already linked on acct-1; duplicate linked on acct-1 (collision)
    // and acct-2 (safe to move).
    fake.seed("google_contact_links", [
      { gmail_account_id: "acct-1", contact_id: PRIMARY, resource_name: "people/primary" },
      { gmail_account_id: "acct-1", contact_id: DUP, resource_name: "people/dup1" },
      { gmail_account_id: "acct-2", contact_id: DUP, resource_name: "people/dup2" },
    ]);

    const res = await mergeContactDuplicate({ data: { suggestionId: SUGGESTION_ID }, ...ctx });
    expect(res).toEqual({ ok: true, merged: 1 });

    const linkUpdates = fake.calls.updates.filter((u) => u.table === "google_contact_links");
    // Exactly one link moved: the acct-2 one. The acct-1 collision is skipped.
    expect(linkUpdates).toHaveLength(1);
    const filters = linkUpdates[0].filters;
    expect(filters).toContainEqual({ op: "eq", col: "gmail_account_id", value: "acct-2" });
    expect(filters).toContainEqual({ op: "eq", col: "resource_name", value: "people/dup2" });
  });
});

/* -------------------------------------------------------------------------- */
/* mergeContactDuplicate — happy path                                          */
/* -------------------------------------------------------------------------- */

describe("mergeContactDuplicate — happy path", () => {
  it("moves memberships, deletes the duplicate, marks merged and reconciles the survivor", async () => {
    seedSuggestion();
    fake.seed("contact_group_members", [{ group_id: "g1", contact_id: DUP, user_id: USER }]);

    const res = await mergeContactDuplicate({ data: { suggestionId: SUGGESTION_ID }, ...ctx });
    expect(res).toEqual({ ok: true, merged: 1 });

    // Membership upserted onto the primary before the duplicate is deleted.
    const upsert = fake.calls.upserts.find((u) => u.table === "contact_group_members");
    expect(upsert?.payload).toEqual([{ group_id: "g1", contact_id: PRIMARY, user_id: USER }]);

    // Duplicate contact deleted.
    const del = fake.calls.deletes.find((d) => d.table === "contacts");
    expect(del?.filters).toContainEqual({ op: "in", col: "id", value: [DUP] });

    // Suggestion marked merged.
    const statusUpdate = fake.calls.updates.find(
      (u) => u.table === "contact_duplicate_suggestions",
    );
    expect(statusUpdate?.payload).toEqual({ status: "merged" });

    // Survivor reconciled.
    expect(reconcileAutoParentsForContacts).toHaveBeenCalledWith(expect.anything(), USER, [
      PRIMARY,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* dismissContactDuplicate                                                     */
/* -------------------------------------------------------------------------- */

describe("dismissContactDuplicate", () => {
  it("marks the suggestion dismissed", async () => {
    const res = await dismissContactDuplicate({ data: { suggestionId: SUGGESTION_ID }, ...ctx });
    expect(res).toEqual({ ok: true });
    const upd = fake.calls.updates.find((u) => u.table === "contact_duplicate_suggestions");
    expect(upd?.payload).toEqual({ status: "dismissed" });
    expect(upd?.filters).toContainEqual({ op: "eq", col: "id", value: SUGGESTION_ID });
    expect(upd?.filters).toContainEqual({ op: "eq", col: "user_id", value: USER });
  });

  it("propagates a write error", async () => {
    fake.onUpdate("contact_duplicate_suggestions", () => ({ message: "nope" }));
    await expect(
      dismissContactDuplicate({ data: { suggestionId: SUGGESTION_ID }, ...ctx }),
    ).rejects.toThrow("nope");
  });
});

/* -------------------------------------------------------------------------- */
/* mergeContactsManual — ownership / input guards                              */
/* -------------------------------------------------------------------------- */

describe("mergeContactsManual — guards", () => {
  const base = {
    primaryId: PRIMARY,
    loserIds: [DUP],
    fields: {},
    notesSource: null,
    emails: [],
    phones: [],
    excludedGroupIds: [],
    manualLockFields: [],
  };

  it("rejects when the primary is also listed as a loser", async () => {
    await expect(
      mergeContactsManual({ data: { ...base, loserIds: [PRIMARY] }, ...ctx }),
    ).rejects.toThrow("Primary cannot also be a loser");
  });

  it("rejects when some contacts are missing", async () => {
    // Only the primary exists; the loser is absent.
    fake.seed("contacts", [{ id: PRIMARY, user_id: USER, manual_overrides: [] }]);
    await expect(mergeContactsManual({ data: base, ...ctx })).rejects.toThrow(
      "Some contacts not found",
    );
  });

  it("rejects when a contact belongs to a different user", async () => {
    fake.seed("contacts", [
      { id: PRIMARY, user_id: USER, manual_overrides: [] },
      { id: DUP, user_id: "someone-else", manual_overrides: [] },
    ]);
    await expect(mergeContactsManual({ data: base, ...ctx })).rejects.toThrow("Forbidden");
  });
});

/* -------------------------------------------------------------------------- */
/* scanContactDuplicatesImpl — background scan core                            */
/* -------------------------------------------------------------------------- */

describe("scanContactDuplicatesImpl", () => {
  const SCAN_USER = "scan-user";

  beforeEach(() => {
    // Force the AI-free path: deterministic signals still resolve, and no
    // model calls happen without an API key.
    delete process.env.LOVABLE_API_KEY;
  });

  function seedPhonePair(primary: string, dup: string, phone: string, createdBase = "2020-01-01") {
    fake.seed("contacts", [
      // Primary has an email so pickPrimary promotes it.
      {
        id: primary,
        user_id: SCAN_USER,
        name: `Name ${primary}`,
        email: `${primary}@x.com`,
        company: null,
        title: null,
        city: null,
        source: null,
        created_at: `${createdBase}T00:00:00Z`,
      },
      {
        id: dup,
        user_id: SCAN_USER,
        name: `Other ${dup}`,
        email: null,
        company: null,
        title: null,
        city: null,
        source: null,
        created_at: `${createdBase}T01:00:00Z`,
      },
    ]);
    fake.seed("contact_phones", [
      { contact_id: primary, number: phone, user_id: SCAN_USER },
      { contact_id: dup, number: phone, user_id: SCAN_USER },
    ]);
  }

  it("short-circuits when there are fewer than two contacts", async () => {
    fake.seed("contacts", [
      { id: PRIMARY, user_id: SCAN_USER, name: "Solo", created_at: "2020-01-01T00:00:00Z" },
    ]);
    const res = await scanContactDuplicatesImpl(SCAN_USER);
    expect(res).toEqual({
      clustersAnalyzed: 0,
      clustersTotal: 0,
      created: 0,
      truncated: false,
      aiFailures: 0,
    });
    expect(fake.calls.inserts).toHaveLength(0);
  });

  it("records a high-confidence suggestion for an exact-phone cluster (no AI)", async () => {
    seedPhonePair(PRIMARY, DUP, "555-123-4567");

    const res = await scanContactDuplicatesImpl(SCAN_USER);
    expect(res.clustersTotal).toBe(1);
    expect(res.clustersAnalyzed).toBe(1);
    expect(res.created).toBe(1);
    expect(res.aiFailures).toBe(0);
    expect(res.truncated).toBe(false);

    const insert = fake.calls.inserts.find((i) => i.table === "contact_duplicate_suggestions");
    const payload = insert?.payload as Record<string, unknown>;
    expect(payload.primary_contact_id).toBe(PRIMARY);
    expect(payload.duplicate_contact_ids).toEqual([DUP]);
    expect(payload.confidence).toBe("high");
    expect(payload.status).toBe("pending");
  });

  it("never re-proposes a suggestion whose primary was dismissed", async () => {
    seedPhonePair(PRIMARY, DUP, "555-123-4567");
    fake.seed("contact_duplicate_suggestions", [
      { primary_contact_id: PRIMARY, status: "dismissed", user_id: SCAN_USER },
    ]);

    const res = await scanContactDuplicatesImpl(SCAN_USER);
    expect(res.created).toBe(0);
    expect(
      fake.calls.inserts.filter((i) => i.table === "contact_duplicate_suggestions"),
    ).toHaveLength(0);
    // A dismissed row is not pending, so it is never pruned.
    expect(fake.calls.deletes).toHaveLength(0);
  });

  it("prunes stale pending suggestions after a complete scan", async () => {
    seedPhonePair(PRIMARY, DUP, "555-123-4567");
    fake.seed("contact_duplicate_suggestions", [
      { primary_contact_id: "stale-primary", status: "pending", user_id: SCAN_USER },
    ]);

    await scanContactDuplicatesImpl(SCAN_USER);

    const del = fake.calls.deletes.find((d) => d.table === "contact_duplicate_suggestions");
    expect(del?.filters).toContainEqual({
      op: "in",
      col: "primary_contact_id",
      value: ["stale-primary"],
    });
  });

  it("marks the scan truncated and does NOT prune when there are more than MAX_CLUSTERS", async () => {
    // MAX_CLUSTERS is 80; build 81 independent exact-phone clusters.
    const contacts: Record<string, unknown>[] = [];
    const phones: Record<string, unknown>[] = [];
    for (let i = 0; i < 81; i++) {
      const p = `p-${i}`;
      const d = `d-${i}`;
      contacts.push({
        id: p,
        user_id: SCAN_USER,
        name: `P${i}`,
        email: `p${i}@x.com`,
        company: null,
        title: null,
        city: null,
        source: null,
        created_at: `2020-01-01T00:00:${String(i).padStart(2, "0")}Z`,
      });
      contacts.push({
        id: d,
        user_id: SCAN_USER,
        name: `D${i}`,
        email: null,
        company: null,
        title: null,
        city: null,
        source: null,
        created_at: `2020-01-02T00:00:${String(i).padStart(2, "0")}Z`,
      });
      phones.push({ contact_id: p, number: `555-000-${String(1000 + i)}`, user_id: SCAN_USER });
      phones.push({ contact_id: d, number: `555-000-${String(1000 + i)}`, user_id: SCAN_USER });
    }
    fake.seed("contacts", contacts);
    fake.seed("contact_phones", phones);
    // A stale pending suggestion that would be pruned on a *complete* scan.
    fake.seed("contact_duplicate_suggestions", [
      { primary_contact_id: "stale-primary", status: "pending", user_id: SCAN_USER },
    ]);

    const res = await scanContactDuplicatesImpl(SCAN_USER);
    expect(res.clustersTotal).toBe(81);
    expect(res.clustersAnalyzed).toBe(80);
    expect(res.truncated).toBe(true);
    // Pruning must be skipped so results the user still needs are never wiped.
    expect(
      fake.calls.deletes.filter((d) => d.table === "contact_duplicate_suggestions"),
    ).toHaveLength(0);
  });
});
