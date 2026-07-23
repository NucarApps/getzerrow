// Tests for saveScannedContact (src/lib/card-scan.server.ts) — the mobile
// business-card save path. Mirrors the web scanner's save semantics: upsert on
// (user_id, email) so a re-scan updates rather than duplicating, sensitive
// fields go through the encrypted RPC, and phones are replaced in full.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

const setContactEncryptedFields = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./sync/encrypted-writer", () => ({
  setContactEncryptedFields: (...args: unknown[]) => setContactEncryptedFields(...args),
}));

import { saveScannedContact } from "./card-scan.server";

beforeEach(() => {
  fake.reset();
  setContactEncryptedFields.mockClear();
});

describe("saveScannedContact", () => {
  it("upserts on (user_id, email) with a trimmed/lowercased email and normalized name", async () => {
    await saveScannedContact("u1", {
      email: "  Jane@Example.COM ",
      name: "JANE DOE", // all-caps → title-cased by normalizeScannedName
      company: "Acme",
    });

    const upsert = fake.calls.upserts.find((u) => u.table === "contacts");
    expect(upsert).toBeTruthy();
    // Conflict target is the (user_id, email) unique index — the anti-duplication key.
    expect((upsert?.options as { onConflict?: string })?.onConflict).toBe("user_id,email");
    const payload = upsert?.payload as Record<string, unknown>;
    expect(payload.user_id).toBe("u1");
    expect(payload.email).toBe("jane@example.com");
    expect(payload.source).toBe("scan");
    expect(payload.name).toBe("Jane Doe");
  });

  it("writes the primary phone through the encrypted RPC", async () => {
    await saveScannedContact("u1", {
      email: "a@b.com",
      phones: [
        { label: "Work", number: "111", is_primary: false },
        { label: "Cell", number: " 222 ", is_primary: true },
      ],
    });

    expect(setContactEncryptedFields).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "222" }),
    );
  });

  it("replaces phones in full: clears existing then inserts normalized rows", async () => {
    await saveScannedContact("u1", {
      email: "a@b.com",
      phones: [
        { label: "Work", number: " 111 " },
        { label: "CELL", number: "222", is_primary: true },
      ],
    });

    // Existing phones cleared for this contact first.
    expect(fake.calls.deletes.find((d) => d.table === "contact_phones")).toBeTruthy();

    const insert = fake.calls.inserts.find((i) => i.table === "contact_phones");
    const rows = insert?.payload as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: "work", number: "111", is_primary: false, position: 0 });
    // hasPrimary is true (second entry), so is_primary is taken from the entries.
    expect(rows[1]).toMatchObject({ label: "cell", number: "222", is_primary: true, position: 1 });
  });

  it("makes no phone writes when the draft has none", async () => {
    await saveScannedContact("u1", { email: "a@b.com" });
    expect(fake.calls.deletes.filter((d) => d.table === "contact_phones")).toHaveLength(0);
    expect(fake.calls.inserts.filter((i) => i.table === "contact_phones")).toHaveLength(0);
  });

  it("propagates an upsert failure", async () => {
    // A throwing write handler simulates a network-level rejection (the fake's
    // .select().single() form does not surface a returned {error} object).
    fake.onUpsert("contacts", () => {
      throw new Error("conflict boom");
    });
    await expect(saveScannedContact("u1", { email: "a@b.com" })).rejects.toThrow("conflict boom");
  });
});
