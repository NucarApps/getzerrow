// Server fns for the shareable contact card (cards.functions.ts).
//
// `submitCardLead` is the sharp edge here: an UNAUTHENTICATED public write.
// Anyone who knows a handle can insert a contacts row for that handle's
// owner, and anyone who also knows one of that owner's contact addresses can
// append text into that contact's encrypted notes. The contracts below pin
// what it may and may not do:
//
//   * an unknown handle writes NOTHING and reads no PII,
//   * an existing contact is APPENDED to, never overwritten — a stranger
//     cannot rewrite a real contact's name, company, phone or source,
//   * a new contact takes its user_id from the CARD's owner, not from
//     anything the submitter sent,
//   * the encrypted write uses the "leave alone" sentinel for fields the
//     submitter omitted, so a blank field never CLEARS a stored one.
//
// The encrypted-field writer is left real and driven through the fake's RPC
// handler, so the p_clear sentinel is asserted rather than assumed.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { callWithRlsClient } from "@/lib/__fixtures__/rls-server-fn";

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

const sendCardEmail = vi.hoisted(() => vi.fn<typeof import("./cards.server").sendCardEmail>());
vi.mock("./cards.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cards.server")>()),
  sendCardEmail,
}));

import {
  getMyCard,
  upsertMyCard,
  getPublicCard,
  getPublicVCard,
  sendMyCard,
  submitCardLead,
} from "./cards.functions";

const OWNER = "owner-user-1";
const CARD_ID = "card-1";
const CONTACT_ID = "cccccccc-0000-4000-8000-000000000001";
const NEW_CONTACT_ID = "contact-new";
const ACCOUNT_ID = "account-1";

/** The public card a stranger is looking at. */
function seedCard(over: { handle?: string; user_id?: string } = {}) {
  fake.seed("my_cards", [
    {
      id: CARD_ID,
      user_id: over.user_id ?? OWNER,
      handle: over.handle ?? "jane",
      name: "Jane Doe",
      title: "CTO",
      company: "Acme",
      email: "jane@acme.test",
      phone: "+1 555 0100",
      website: "https://acme.test",
      linkedin: null,
      twitter: null,
      tagline: "We build things",
      avatar_url: null,
      cover_url: null,
      theme: "ocean",
    },
  ]);
}

/** Make the contacts insert return a DB-generated id, like PostgREST does. */
function injectContactId() {
  fake.onInsert("contacts", () => ({ data: { id: NEW_CONTACT_ID } }));
}

function rpcNames() {
  return fake.calls.rpcs.map((r) => r.fn);
}

beforeEach(() => {
  fake.reset();
  vi.stubEnv("EMAIL_ENC_KEY", "test-enc-key");
});

describe("getMyCard", () => {
  it("returns the caller's card through the user-scoped client", async () => {
    // RLS-RELIANCE: the query carries no user_id filter — row visibility is
    // the database's job, so the fake is seeded with only what RLS would show.
    fake.seed("my_cards", [{ id: CARD_ID, user_id: TEST_USER, handle: "jane" }]);
    const { card } = await callWithRlsClient(getMyCard, { fake })();
    expect(card).toMatchObject({ id: CARD_ID, handle: "jane" });
  });

  it("returns null before the user has made a card", async () => {
    fake.seed("my_cards", []);
    expect(await callWithRlsClient(getMyCard, { fake })()).toStrictEqual({ card: null });
  });
});

describe("upsertMyCard", () => {
  it("writes the card with the caller's user_id and normalized URLs", async () => {
    const { card } = await upsertMyCard({
      data: {
        handle: "jane",
        name: "Jane Doe",
        website: "acme.test",
        // avatar/cover are forced to https here, unlike website/linkedin.
        avatar_url: "http://cdn.test/a.png",
        cover_url: "cdn.test/c.png",
      },
    });
    expect(card).toMatchObject({
      user_id: TEST_USER,
      handle: "jane",
      website: "https://acme.test",
      avatar_url: "https://cdn.test/a.png",
      cover_url: "https://cdn.test/c.png",
    });
    expect(fake.calls.upserts[0]?.options).toStrictEqual({ onConflict: "user_id" });
  });

  it("refuses a handle another user already holds, before writing anything", async () => {
    fake.seed("my_cards", [{ id: CARD_ID, user_id: OWNER, handle: "jane" }]);
    await expect(upsertMyCard({ data: { handle: "jane" } })).rejects.toThrow(
      "That handle is already taken — try another.",
    );
    expect(writeCount(fake)).toBe(0);
  });

  it("lets the owner re-save their own handle", async () => {
    fake.seed("my_cards", [{ id: CARD_ID, user_id: TEST_USER, handle: "jane" }]);
    await expect(
      upsertMyCard({ data: { handle: "jane", name: "New name" } }),
    ).resolves.toMatchObject({ card: { name: "New name" } });
  });

  it.each(["ab", "JaneDoe", "-jane", "jane.doe", "j".repeat(32)])(
    "rejects the handle %s at the validator, before any read",
    async (handle) => {
      await expect(upsertMyCard({ data: { handle } })).rejects.toThrow();
      expect(fake.calls.selects).toEqual([]);
    },
  );

  it("surfaces a failed write", async () => {
    fake.onUpsert("my_cards", () => {
      throw new Error("unique violation");
    });
    await expect(upsertMyCard({ data: { handle: "jane" } })).rejects.toThrow("unique violation");
  });
});

describe("getPublicCard", () => {
  it("projects only the publishable columns and lower-cases the handle", async () => {
    seedCard();
    const { card } = await getPublicCard({ data: { handle: "jane" } });
    expect(card).toBeTruthy();
    expect(fake.calls.selects[0]?.columns).toBe(
      "handle,name,title,company,email,phone,website,linkedin,twitter,avatar_url,cover_url,tagline,theme",
    );
    // user_id is not in the projection, so a public page cannot learn it.
    expect(fake.calls.selects[0]?.columns).not.toContain("user_id");
  });

  it("returns a null card for an unknown handle", async () => {
    fake.seed("my_cards", []);
    expect(await getPublicCard({ data: { handle: "nobody" } })).toStrictEqual({ card: null });
  });
});

describe("getPublicVCard", () => {
  it("renders the card as a vCard including the public link", async () => {
    seedCard();
    const { vcard } = await getPublicVCard({
      data: { handle: "jane", publicUrl: "https://atzro.test/c/jane" },
    });
    expect(vcard.split("\r\n")).toContain("FN:Jane Doe");
    expect(vcard.split("\r\n")).toContain("URL;TYPE=Atzro:https://atzro.test/c/jane");
  });

  it("refuses an unknown handle", async () => {
    fake.seed("my_cards", []);
    await expect(getPublicVCard({ data: { handle: "nobody" } })).rejects.toThrow("Card not found");
  });
});

describe("sendMyCard", () => {
  beforeEach(() => {
    fake.seed("my_cards", [{ id: CARD_ID, user_id: TEST_USER, handle: "jane", name: "Jane Doe" }]);
    fake.seed("gmail_accounts", [
      { id: ACCOUNT_ID, user_id: TEST_USER, email_address: "jane@work.test" },
    ]);
  });

  it("sends through the caller's oldest inbox and records who it went to", async () => {
    const send = callWithRlsClient(sendMyCard, { fake });
    expect(
      await send({
        data: {
          toEmail: "Friend@Example.test",
          contactId: CONTACT_ID,
          publicBaseUrl: "https://atzro.test/",
        },
      }),
    ).toStrictEqual({ ok: true });

    expect(sendCardEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        fromEmail: "jane@work.test",
        toEmail: "Friend@Example.test",
        // The trailing slash on the base URL is not doubled.
        publicUrl: "https://atzro.test/c/jane",
      }),
    );
    expect(fake.calls.inserts).toHaveLength(1);
    expect(fake.calls.inserts[0]?.table).toBe("contact_cards_sent");
    expect(fake.calls.inserts[0]?.payload).toStrictEqual({
      user_id: TEST_USER,
      contact_id: CONTACT_ID,
      to_email: "friend@example.test",
    });
  });

  it("tells the user to set up a card first when they have none", async () => {
    fake.seed("my_cards", []);
    await expect(
      callWithRlsClient(sendMyCard, { fake })({
        data: { toEmail: "f@e.test", publicBaseUrl: "https://atzro.test" },
      }),
    ).rejects.toThrow("Set up your card first at /my-card");
    expect(sendCardEmail).not.toHaveBeenCalled();
  });

  it("tells the user to connect Gmail when they have no inbox", async () => {
    fake.seed("gmail_accounts", []);
    await expect(
      callWithRlsClient(sendMyCard, { fake })({
        data: { toEmail: "f@e.test", publicBaseUrl: "https://atzro.test" },
      }),
    ).rejects.toThrow("Connect your Gmail account in Settings first.");
    expect(writeCount(fake)).toBe(0);
  });
});

describe("submitCardLead — the unauthenticated public write", () => {
  it("writes nothing at all for an unknown handle", async () => {
    fake.seed("my_cards", []);
    fake.seed("contacts", [{ id: CONTACT_ID, user_id: OWNER, email: "lead@example.test" }]);

    await expect(
      submitCardLead({ data: { handle: "nobody", name: "Mallory", email: "lead@example.test" } }),
    ).rejects.toThrow("Card not found");

    expect(writeCount(fake)).toBe(0);
    // And no decrypt of anyone's notes was attempted.
    expect(fake.calls.rpcs).toEqual([]);
  });

  describe("when the owner has no contact at that address", () => {
    beforeEach(() => {
      seedCard();
      fake.seed("contacts", []);
      injectContactId();
    });

    it("creates the contact under the CARD owner and marks its source", async () => {
      await expect(
        submitCardLead({
          data: {
            handle: "jane",
            name: "Mallory Lead",
            email: "Lead@Example.test",
            company: "Initech",
            phone: "+1 555 0199",
            message: "Loved the talk",
          },
        }),
      ).resolves.toStrictEqual({ ok: true });

      const insert = fake.calls.inserts.find((i) => i.table === "contacts");
      expect(insert?.payload).toStrictEqual({
        // Taken from the card, never from the submitted payload.
        user_id: OWNER,
        email: "lead@example.test",
        name: "Mallory Lead",
        company: "Initech",
        source: "card_lead",
      });
    });

    it("stores the phone and the lead note through the encrypted RPC", async () => {
      await submitCardLead({
        data: {
          handle: "jane",
          name: "Mallory Lead",
          email: "lead@example.test",
          phone: "+1 555 0199",
          message: "Loved the talk",
        },
      });

      expect(fake.calls.rpcs).toStrictEqual([
        {
          fn: "set_contact_encrypted_fields",
          args: {
            p_contact_id: NEW_CONTACT_ID,
            p_notes: "Lead via /c/jane: Loved the talk",
            p_relationship_summary: null,
            p_address_line1: null,
            p_address_line2: null,
            p_phone: "+1 555 0199",
            // Nothing is CLEARED: an omitted field must not wipe a stored one.
            p_clear: [],
            p_key: "test-enc-key",
          },
        },
      ]);
    });

    it("records a bare note when the submitter left the message empty", async () => {
      await submitCardLead({
        data: { handle: "jane", name: "Mallory", email: "lead@example.test", message: "" },
      });
      expect(fake.calls.rpcs[0]?.args).toMatchObject({
        p_notes: "Lead via /c/jane",
        p_phone: null,
        p_clear: [],
      });
    });

    it("logs the lead as a card_event against the owner's card", async () => {
      await submitCardLead({
        data: { handle: "jane", name: "Mallory", email: "lead@example.test" },
      });
      const event = fake.calls.inserts.find((i) => i.table === "card_events");
      expect(event?.payload).toStrictEqual({
        card_id: CARD_ID,
        owner_user_id: OWNER,
        handle: "jane",
        event_type: "lead",
      });
    });

    it("normalizes the handle before looking the card up and logging it", async () => {
      seedCard({ handle: "jane" });
      await submitCardLead({
        data: { handle: "jane", name: "Mallory", email: "lead@example.test" },
      });
      expect(fake.calls.inserts.find((i) => i.table === "card_events")?.payload).toMatchObject({
        handle: "jane",
      });
    });

    it.each([
      ["a bad handle", { handle: "NO", name: "M", email: "a@b.test" }],
      ["a missing name", { handle: "jane", email: "a@b.test" }],
      ["a blank name", { handle: "jane", name: "   ", email: "a@b.test" }],
      ["a malformed email", { handle: "jane", name: "M", email: "nope" }],
      [
        "a message over 1000 characters",
        { handle: "jane", name: "M", email: "a@b.test", message: "x".repeat(1001) },
      ],
    ])("refuses %s at the validator with no read and no write", async (_label, data) => {
      await expect(submitCardLead({ data })).rejects.toThrow();
      expect(fake.calls.selects).toEqual([]);
      expect(writeCount(fake)).toBe(0);
    });
  });

  describe("when the owner already has a contact at that address", () => {
    beforeEach(() => {
      seedCard();
      fake.seed("contacts", [
        {
          id: CONTACT_ID,
          user_id: OWNER,
          email: "lead@example.test",
          name: "Mallory Real",
          company: "Real Corp",
          source: "gmail",
        },
      ]);
      fake.onRpc("get_contact_decrypted", () => ({
        data: [{ id: CONTACT_ID, notes: "Met at the 2025 offsite." }],
      }));
    });

    it("appends to the notes and inserts no second contacts row", async () => {
      await submitCardLead({
        data: {
          handle: "jane",
          name: "Mallory Lead",
          email: "lead@example.test",
          company: "Initech",
          phone: "+1 555 0199",
          message: "Loved the talk",
        },
      });

      expect(fake.calls.inserts.filter((i) => i.table === "contacts")).toHaveLength(0);
      const write = fake.calls.rpcs.find((r) => r.fn === "set_contact_encrypted_fields");
      expect(write?.args.p_notes).toBe(
        "Met at the 2025 offsite.\n\n" +
          "Lead via /c/jane: Loved the talk\n" +
          "Name given: Mallory Lead\n" +
          "Company given: Initech\n" +
          "Phone given: +1 555 0199",
      );
    });

    it("never overwrites the stored identity fields — the details go in the note", async () => {
      await submitCardLead({
        data: {
          handle: "jane",
          name: "Impostor",
          email: "lead@example.test",
          company: "Evil Corp",
          phone: "+1 555 6666",
        },
      });

      // No contacts write of any kind: name, company, phone and source stand.
      expect(fake.calls.updates.filter((u) => u.table === "contacts")).toHaveLength(0);
      expect(fake.calls.upserts.filter((u) => u.table === "contacts")).toHaveLength(0);
      expect(fake.calls.inserts.filter((i) => i.table === "contacts")).toHaveLength(0);
      // The phone is NOT written to the encrypted phone column either.
      const write = fake.calls.rpcs.find((r) => r.fn === "set_contact_encrypted_fields");
      expect(write?.args.p_phone).toBeNull();
      expect(write?.args.p_clear).toStrictEqual([]);
    });

    it("uses the lead block alone when the contact had no notes", async () => {
      fake.onRpc("get_contact_decrypted", () => ({ data: [{ id: CONTACT_ID, notes: null }] }));
      await submitCardLead({
        data: { handle: "jane", name: "Mallory", email: "lead@example.test" },
      });
      expect(
        fake.calls.rpcs.find((r) => r.fn === "set_contact_encrypted_fields")?.args.p_notes,
      ).toBe("Lead via /c/jane\nName given: Mallory");
    });

    it("reads the notes through exactly one decrypt RPC", async () => {
      await submitCardLead({
        data: { handle: "jane", name: "Mallory", email: "lead@example.test" },
      });
      expect(rpcNames()).toStrictEqual(["get_contact_decrypted", "set_contact_encrypted_fields"]);
    });

    // CHARACTERIZATION(card-lead-public-writes-unthrottled): submitCardLead is
    // unauthenticated and has no rate limit, so anyone who knows a handle and
    // one of that owner's contact addresses can append to that contact's
    // encrypted notes as many times as they like.
    it("accepts an unlimited run of submissions against the same contact", async () => {
      for (let i = 0; i < 5; i++) {
        await submitCardLead({
          data: {
            handle: "jane",
            name: "Mallory",
            email: "lead@example.test",
            message: "x".repeat(1000),
          },
        });
      }
      expect(fake.calls.rpcs.filter((r) => r.fn === "set_contact_encrypted_fields")).toHaveLength(
        5,
      );
      expect(fake.calls.inserts.filter((i) => i.table === "card_events")).toHaveLength(5);
    });
  });
});
