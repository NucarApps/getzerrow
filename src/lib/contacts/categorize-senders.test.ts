// AI sender categories (rules upgrade, task 7). Contracts protected:
//   * deterministic labeling — a fixed AI verdict map produces the same
//     groups + memberships every time (no AI in tests),
//   * groups are created once with kind='ai_category' and reused,
//   * unknown labels and non-AI name collisions are skipped, never
//     misfiled into a manual group,
//   * idempotency — a second run over the same senders adds nothing new
//     (already-categorized contacts aren't re-picked),
//   * the default AI labeler's prompt/parse contract, and the nightly
//     entrypoint's per-user isolation.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import type { CategorizeAiFn } from "./categorize-senders.server";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));
vi.mock("@/lib/log.server", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

const generateText =
  vi.fn<(opts: { model: unknown; prompt: string }) => Promise<{ text: string }>>();
vi.mock("ai", () => ({
  generateText: (opts: { model: unknown; prompt: string }) => generateText(opts),
}));
vi.mock("@/lib/ai-gateway", () => ({ getModel: () => ({ modelId: "test-model" }) }));

// The real race is kept (it clears its own timer); the spy is only here so
// the test can assert the call is actually timeboxed.
const raceTimeout = vi.fn(async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  const { raceTimeout: real } =
    await vi.importActual<typeof import("@/lib/ai-budget")>("@/lib/ai-budget");
  return real(p, ms, label);
});
vi.mock("@/lib/ai-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-budget")>();
  return {
    ...actual,
    raceTimeout: <T>(p: Promise<T>, ms: number, label: string) => raceTimeout(p, ms, label),
  };
});

// Dynamic import AFTER the mocks + fixture exist (static imports hoist
// above `const fake`, which would run the mock factory too early).
const {
  categorizeSendersForUser,
  categorizeSenders,
  labelSendersWithAi,
  SENDER_CATEGORIES,
  MAX_SENDERS_PER_USER,
} = await import("./categorize-senders.server");
const { logError } = await import("@/lib/log.server");
const { AI_CLASSIFY_ATTEMPT_TIMEOUT_MS } = await import("@/lib/sync/config");

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

  it("reuses an existing ai_category group instead of creating a second one", async () => {
    fake.seed("contact_groups", [
      { id: "g-ai", user_id: USER, name: "Recruiters", kind: "ai_category", color: "#8b5cf6" },
    ]);

    const r = await categorizeSendersForUser(USER, async () => ({
      "maya@lattice-talent.com": "recruiter",
    }));

    expect(r.labeled).toBe(1);
    expect(fake.calls.inserts.filter((i) => i.table === "contact_groups")).toStrictEqual([]);
    const membership = fake.calls.upserts.find((u) => u.table === "contact_group_members");
    expect(membership?.payload).toStrictEqual({
      group_id: "g-ai",
      contact_id: "c-1",
      user_id: USER,
    });
    expect(membership?.options).toStrictEqual({
      onConflict: "group_id,contact_id",
      ignoreDuplicates: true,
    });
  });

  it("creates the group with a client-stable CardDAV uid so iOS can sync it", async () => {
    await categorizeSendersForUser(USER, async () => ({
      "maya@lattice-talent.com": "recruiter",
    }));

    const insert = fake.calls.inserts.find((i) => i.table === "contact_groups");
    const payload = insert?.payload as { id: string; carddav_uid: string; color: string };
    expect(payload.carddav_uid).toBe(`group-${payload.id}`);
    expect(payload.color).toBe("#8b5cf6");
  });

  it("skips a sender whose group could not be created", async () => {
    fake.onInsert("contact_groups", () => ({ message: "unique violation" }));

    const r = await categorizeSendersForUser(USER, async () => ({
      "maya@lattice-talent.com": "recruiter",
    }));

    expect(r).toStrictEqual({ labeled: 0, skipped: 3 });
    expect(fake.calls.upserts).toStrictEqual([]);
  });

  it("skips a sender whose membership write fails", async () => {
    fake.onUpsert("contact_group_members", () => ({ message: "row level security" }));

    const r = await categorizeSendersForUser(USER, async () => ({
      "maya@lattice-talent.com": "recruiter",
    }));

    expect(r).toStrictEqual({ labeled: 0, skipped: 3 });
  });

  it("normalizes the verdict's casing and padding before matching the label set", async () => {
    const r = await categorizeSendersForUser(USER, async () => ({
      "maya@lattice-talent.com": "  Recruiter  ",
    }));

    expect(r.labeled).toBe(1);
  });

  it("ignores contacts with no email address", async () => {
    fake.seed("contacts", [
      { id: "c-1", user_id: USER, email: null, name: "No mail", created_at: "2026-07-20" },
      { id: "c-2", user_id: USER, email: "a@x.com", name: null, created_at: "2026-07-19" },
    ]);
    const ai = vi.fn<CategorizeAiFn>(async () => ({ "a@x.com": "vendor" }));

    await categorizeSendersForUser(USER, ai);

    expect(ai).toHaveBeenCalledWith([{ contact_id: "c-2", email: "a@x.com", name: null }]);
  });

  it("caps one run at MAX_SENDERS_PER_USER and lowercases the addresses it sends", async () => {
    fake.seed(
      "contacts",
      Array.from({ length: MAX_SENDERS_PER_USER + 10 }, (_, i) => ({
        id: `c-${i}`,
        user_id: USER,
        email: `Sender${i}@Acme.com`,
        name: null,
        created_at: `2026-07-${String(i + 1).padStart(2, "0")}`,
      })),
    );
    const ai = vi.fn<CategorizeAiFn>(async () => ({}));

    await categorizeSendersForUser(USER, ai);

    const sent = ai.mock.calls[0]?.[0] ?? [];
    expect(sent).toHaveLength(MAX_SENDERS_PER_USER);
    expect(sent.every((s) => s.email === s.email.toLowerCase())).toBe(true);
  });

  it("never calls the model when the user has no contacts", async () => {
    fake.seed("contacts", []);
    const ai = vi.fn<CategorizeAiFn>(async () => ({}));

    expect(await categorizeSendersForUser(USER, ai)).toStrictEqual({ labeled: 0, skipped: 0 });
    expect(ai).not.toHaveBeenCalled();
  });
});

describe("labelSendersWithAi", () => {
  it("names every allowed category, includes the display names, and is timeboxed", async () => {
    generateText.mockResolvedValue({
      text: '{"maya@lattice-talent.com":"recruiter"}',
    });

    const verdicts = await labelSendersWithAi([
      { contact_id: "c-1", email: "maya@lattice-talent.com", name: "Maya Lattice" },
    ]);

    expect(verdicts).toStrictEqual({ "maya@lattice-talent.com": "recruiter" });
    const prompt = generateText.mock.calls[0]?.[0].prompt ?? "";
    for (const key of Object.keys(SENDER_CATEGORIES)) expect(prompt).toContain(key);
    expect(prompt).toContain("maya@lattice-talent.com (Maya Lattice)");
    expect(raceTimeout).toHaveBeenCalledWith(
      expect.anything(),
      AI_CLASSIFY_ATTEMPT_TIMEOUT_MS,
      "categorize-senders",
    );
  });

  it("extracts the JSON object from a chatty or fenced reply", async () => {
    generateText.mockResolvedValue({
      text: 'Sure!\n```json\n{"a@x.com":"vendor"}\n```\nHope that helps.',
    });

    expect(
      await labelSendersWithAi([{ contact_id: "c", email: "a@x.com", name: null }]),
    ).toStrictEqual({ "a@x.com": "vendor" });
  });

  it("throws rather than returning a half-parsed verdict map", async () => {
    generateText.mockResolvedValue({ text: '{"a@x.com": 7}' });

    await expect(
      labelSendersWithAi([{ contact_id: "c", email: "a@x.com", name: null }]),
    ).rejects.toThrow();
  });

  it("truncates a long display name rather than growing the prompt", async () => {
    generateText.mockResolvedValue({ text: "{}" });

    await labelSendersWithAi([{ contact_id: "c", email: "a@x.com", name: "N".repeat(100) }]);

    expect(generateText.mock.calls[0]?.[0].prompt).toContain(`a@x.com (${"N".repeat(60)})`);
  });
});

describe("categorizeSenders (nightly entrypoint)", () => {
  it("runs once per distinct user across their connected accounts", async () => {
    fake.seed("gmail_accounts", [
      { id: "a-1", user_id: USER },
      { id: "a-2", user_id: USER },
      { id: "a-3", user_id: "u-2" },
    ]);
    fake.seed("contacts", [
      { id: "c-1", user_id: USER, email: "maya@lattice-talent.com", created_at: "2026-07-20" },
      { id: "c-9", user_id: "u-2", email: "lenny@substack.com", created_at: "2026-07-20" },
    ]);

    const res = await categorizeSenders(async (senders) =>
      Object.fromEntries(senders.map((s) => [s.email, "vendor"])),
    );

    expect(res).toStrictEqual({ users: 2, labeled: 2, skipped: 0 });
  });

  it("isolates one user's failure from the rest of the run", async () => {
    fake.seed("gmail_accounts", [
      { id: "a-1", user_id: USER },
      { id: "a-2", user_id: "u-2" },
    ]);
    fake.seed("contacts", [
      { id: "c-1", user_id: USER, email: "maya@lattice-talent.com", created_at: "2026-07-20" },
      { id: "c-9", user_id: "u-2", email: "lenny@substack.com", created_at: "2026-07-20" },
    ]);

    const res = await categorizeSenders(async (senders) => {
      if (senders[0]?.email === "maya@lattice-talent.com") throw new Error("gateway 503");
      return { "lenny@substack.com": "newsletter" };
    });

    expect(res).toStrictEqual({ users: 2, labeled: 1, skipped: 0 });
    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      "categorize_senders.user_failed",
      { user_id: USER },
      expect.any(Error),
    );
  });

  it("surfaces a failed account read rather than reporting an empty run", async () => {
    fake.onSelect("gmail_accounts", () => ({ message: "statement timeout" }));

    await expect(categorizeSenders(async () => ({}))).rejects.toThrow("statement timeout");
  });

  it("reports zero users when nobody has a connected account", async () => {
    fake.seed("gmail_accounts", []);
    const ai = vi.fn<CategorizeAiFn>(async () => ({}));

    expect(await categorizeSenders(ai)).toStrictEqual({ users: 0, labeled: 0, skipped: 0 });
    expect(ai).not.toHaveBeenCalled();
  });
});
