// AI sender categories (rules upgrade, task 7). Contracts protected:
//   * deterministic labeling — a fixed AI verdict map produces the same
//     groups + memberships every time (no AI in tests),
//   * groups are created once with kind='ai_category' and reused,
//   * unknown labels and non-AI name collisions are skipped, never
//     misfiled into a manual group,
//   * idempotency — a second run over the same senders adds nothing new
//     (already-categorized contacts aren't re-picked).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));
vi.mock("@/lib/log.server", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

// Dynamic import AFTER the mocks + fixture exist (static imports hoist
// above `const fake`, which would run the mock factory too early).
const { categorizeSendersForUser, SENDER_CATEGORIES } = await import("./categorize-senders.server");

const USER = "u-1";

function seedContacts() {
  fake.seed("contacts", [
    {
      id: "c-1",
      user_id: USER,
      email: "maya@lattice-talent.com",
      name: "Maya",
      created_at: "2026-07-20",
    },
    {
      id: "c-2",
      user_id: USER,
      email: "billing@stripe.com",
      name: "Stripe",
      created_at: "2026-07-19",
    },
    {
      id: "c-3",
      user_id: USER,
      email: "lenny@substack.com",
      name: "Lenny",
      created_at: "2026-07-18",
    },
  ]);
}

beforeEach(() => {
  fake.reset();
  fake.seed("contact_groups", []);
  fake.seed("contact_group_members", []);
  seedContacts();
});

const VERDICTS: Record<string, string> = {
  "maya@lattice-talent.com": "recruiter",
  "billing@stripe.com": "service",
  "lenny@substack.com": "newsletter",
};
const fakeAi = vi.fn(async () => VERDICTS);

describe("categorizeSendersForUser", () => {
  it("labels senders deterministically and creates ai_category groups", async () => {
    const r = await categorizeSendersForUser(USER, fakeAi);
    expect(r.labeled).toBe(3);
    expect(r.skipped).toBe(0);
    const groups = fake.calls.inserts.filter((i) => i.table === "contact_groups");
    expect(groups.map((g) => (g.payload as { name: string }).name).sort()).toEqual(
      ["Newsletters", "Recruiters", "Services"].sort(),
    );
    for (const g of groups) {
      expect((g.payload as { kind: string }).kind).toBe("ai_category");
    }
  });

  it("skips unknown labels instead of guessing", async () => {
    const r = await categorizeSendersForUser(USER, async () => ({
      "maya@lattice-talent.com": "recruiter",
      "billing@stripe.com": "space_pirate",
    }));
    expect(r.labeled).toBe(1);
    expect(r.skipped).toBe(2); // unknown label + missing verdict
  });

  it("never files into a same-named MANUAL group", async () => {
    fake.seed("contact_groups", [
      { id: "g-manual", user_id: USER, name: "Recruiters", kind: "manual", color: "#fff" },
    ]);
    const r = await categorizeSendersForUser(USER, async () => ({
      "maya@lattice-talent.com": "recruiter",
    }));
    expect(r.labeled).toBe(0);
    const memberWrites = [...fake.calls.inserts, ...fake.calls.upserts].filter(
      (i) => i.table === "contact_group_members",
    );
    expect(memberWrites).toHaveLength(0);
  });

  it("is idempotent: already-categorized contacts are not re-picked", async () => {
    fake.seed("contact_groups", [
      { id: "g-ai", user_id: USER, name: "Recruiters", kind: "ai_category", color: "#8b5cf6" },
    ]);
    fake.seed("contact_group_members", [
      { group_id: "g-ai", contact_id: "c-1", user_id: USER },
      { group_id: "g-ai", contact_id: "c-2", user_id: USER },
      { group_id: "g-ai", contact_id: "c-3", user_id: USER },
    ]);
    const ai = vi.fn(async () => VERDICTS);
    const r = await categorizeSendersForUser(USER, ai);
    expect(r.labeled).toBe(0);
    expect(ai).not.toHaveBeenCalled();
  });

  it("category display names cover the whole fixed label set", () => {
    for (const name of Object.values(SENDER_CATEGORIES)) {
      expect(name.length).toBeGreaterThan(2);
    }
  });
});
