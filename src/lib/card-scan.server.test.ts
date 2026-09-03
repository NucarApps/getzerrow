// Tests for src/lib/card-scan.server.ts — the business-card scanner shared by
// the mobile API and the web's /contacts/scan server fns.
//
// extractCardDraft: the structured -> lenient-JSON -> smaller/larger model
// cascade. Each rung is exercised in order, and the give-up case asserts that
// a total failure surfaces as one readable Error naming the last cause rather
// than a provider exception escaping to the caller.
//
// saveScannedContact: the save semantics — upsert on (user_id, email) so a
// re-scan updates rather than duplicating, sensitive fields written only
// through the encrypted RPC, and phones replaced in full.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const setContactEncryptedFields = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./sync/encrypted-writer", () => ({
  setContactEncryptedFields: (...args: unknown[]) => setContactEncryptedFields(...args),
}));

/** One `generateText` call the cascade made. */
type Attempt = { model: string; structured: boolean };
/** What the next call should do: hand back a structured object, hand back
 * text, or fail the way a provider SDK does. */
type PlanEntry = { output: CardScanDraft } | { text: string } | { error: string };

type GenerateArgs = {
  model: { modelId: string };
  output?: unknown;
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
};

const ai = vi.hoisted(() => ({
  generateText: vi.fn<(args: unknown) => Promise<{ output?: unknown; text?: string }>>(),
}));
vi.mock("ai", () => ({
  generateText: ai.generateText,
  Output: { object: (opts: unknown) => opts },
}));

vi.mock("./ai-gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai-gateway")>()),
  // The real getModel builds a gateway client from env; the cascade only
  // cares which model id each rung asked for.
  getModel: (modelId: string) => ({ modelId }),
}));

import { extractCardDraft, saveScannedContact, type CardScanDraft } from "./card-scan.server";

const attempts: Attempt[] = [];
let plan: PlanEntry[] = [];

const IMAGE = "data:image/jpeg;base64,AAAA";

const DRAFT: CardScanDraft = {
  name: "Jane Doe",
  title: "CTO",
  company: "Acme",
  email: "jane@acme.test",
  phone: "+1 555 0100",
  website: "https://acme.test",
  linkedin: null,
  twitter: null,
};
const DRAFT_JSON = JSON.stringify(DRAFT);

function rungs() {
  return attempts.map((a) => `${a.structured ? "structured" : "text"}:${a.model}`);
}

beforeEach(() => {
  fake.reset();
  setContactEncryptedFields.mockClear();
  attempts.length = 0;
  plan = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  ai.generateText.mockImplementation(async (raw) => {
    const args = raw as GenerateArgs;
    attempts.push({ model: args.model.modelId, structured: args.output !== undefined });
    const entry = plan.shift();
    if (!entry) throw new Error("no planned outcome for this attempt");
    if ("error" in entry) throw Object.assign(new Error(entry.error), { name: "AI_APICallError" });
    if ("output" in entry) return { output: entry.output };
    return { text: entry.text };
  });
});

describe("extractCardDraft", () => {
  it("returns the structured output of the first model when it succeeds", async () => {
    plan = [{ output: DRAFT }];
    await expect(extractCardDraft(IMAGE)).resolves.toStrictEqual(DRAFT);
    expect(rungs()).toStrictEqual(["structured:google/gemini-2.5-flash"]);
  });

  it("sends the instruction and the image as one user message", async () => {
    plan = [{ output: DRAFT }];
    await extractCardDraft(IMAGE);
    const args = ai.generateText.mock.calls[0]?.[0] as GenerateArgs;
    expect(args.messages).toHaveLength(1);
    expect(args.messages[0]?.role).toBe("user");
    expect(args.messages[0]?.content[1]).toStrictEqual({ type: "image", image: IMAGE });
    expect(String(args.messages[0]?.content[0]?.text)).toContain("business card photo");
  });

  it("falls back to plain-JSON text on the same model when structured output fails", async () => {
    plan = [{ error: "no tool support" }, { text: DRAFT_JSON }];
    await expect(extractCardDraft(IMAGE)).resolves.toStrictEqual(DRAFT);
    expect(rungs()).toStrictEqual([
      "structured:google/gemini-2.5-flash",
      "text:google/gemini-2.5-flash",
    ]);
  });

  it("parses a fenced, chatty JSON response leniently", async () => {
    plan = [{ error: "no tool support" }, { text: `Sure!\n\`\`\`json\n${DRAFT_JSON}\n\`\`\`\n` }];
    await expect(extractCardDraft(IMAGE)).resolves.toStrictEqual(DRAFT);
  });

  it("drops to the lite model when both attempts on the first model fail", async () => {
    plan = [{ error: "429" }, { text: "not json at all" }, { output: DRAFT }];
    await expect(extractCardDraft(IMAGE)).resolves.toStrictEqual(DRAFT);
    expect(rungs()).toStrictEqual([
      "structured:google/gemini-2.5-flash",
      "text:google/gemini-2.5-flash",
      "structured:google/gemini-2.5-flash-lite",
    ]);
  });

  it("treats JSON that does not satisfy the schema as a failed attempt", async () => {
    // Valid JSON, wrong shape: `name` is nullable but not optional.
    plan = [
      { error: "429" },
      { text: '{"company":"Acme"}' },
      { error: "429" },
      { text: DRAFT_JSON },
    ];
    await expect(extractCardDraft(IMAGE)).resolves.toStrictEqual(DRAFT);
    expect(rungs()).toStrictEqual([
      "structured:google/gemini-2.5-flash",
      "text:google/gemini-2.5-flash",
      "structured:google/gemini-2.5-flash-lite",
      "text:google/gemini-2.5-flash-lite",
    ]);
  });

  it("tries the pro model last, and only as plain JSON", async () => {
    plan = [
      { error: "429" },
      { error: "429" },
      { error: "429" },
      { error: "429" },
      { text: DRAFT_JSON },
    ];
    await expect(extractCardDraft(IMAGE)).resolves.toStrictEqual(DRAFT);
    expect(rungs()).toStrictEqual([
      "structured:google/gemini-2.5-flash",
      "text:google/gemini-2.5-flash",
      "structured:google/gemini-2.5-flash-lite",
      "text:google/gemini-2.5-flash-lite",
      "text:google/gemini-2.5-pro",
    ]);
  });

  it("gives up after five attempts with one Error naming the last cause", async () => {
    plan = [
      { error: "flash structured died" },
      { error: "flash text died" },
      { error: "lite structured died" },
      { error: "lite text died" },
      { error: "pro text died" },
    ];
    // No provider exception escapes: the caller sees one readable failure.
    await expect(extractCardDraft(IMAGE)).rejects.toThrow(
      /^Couldn't read the card: AI vision returned no parseable response \(last error: .*pro text died.*\)$/,
    );
    expect(attempts).toHaveLength(5);
  });

  it("reports an unparseable last response rather than an exception", async () => {
    plan = [
      { error: "429" },
      { error: "429" },
      { error: "429" },
      { error: "429" },
      { text: "I could not read that card." },
    ];
    await expect(extractCardDraft(IMAGE)).rejects.toThrow(/empty\/non-JSON response \(len=27\)/);
  });

  it("labels its log lines with the caller-supplied label", async () => {
    plan = [{ error: "boom" }, { text: DRAFT_JSON }];
    await extractCardDraft(IMAGE, "web card scan");
    expect(console.error).toHaveBeenCalledWith(
      "web card scan structured failed (google/gemini-2.5-flash)",
      expect.stringContaining("boom"),
    );
  });
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
