import { describe, it, expect } from "vitest";
import {
  SCALAR_FIELDS,
  buildMergeRequest,
  seedMergeSelection,
  unionGroupIds,
  type MergePayload,
  type MergeSelection,
} from "./merge-contacts";

type Contact = {
  id: string;
  name: string | null;
  email: string | null;
  title: string | null;
  company: string | null;
  city: string | null;
  notes: string | null;
};

const contact = (id: string, over: Partial<Contact> = {}): Contact => ({
  id,
  name: null,
  email: null,
  title: null,
  company: null,
  city: null,
  notes: null,
  ...over,
});

const email = (
  id: string,
  contact_id: string,
  over: Partial<{ label: string; address: string; is_primary: boolean }> = {},
) => ({
  id,
  contact_id,
  label: "work",
  address: `${id}@acme.com`,
  is_primary: false,
  ...over,
});

const phone = (
  id: string,
  contact_id: string,
  over: Partial<{ label: string; number: string; is_primary: boolean }> = {},
) => ({ id, contact_id, label: "mobile", number: `555-${id}`, is_primary: false, ...over });

function payload(over: Partial<MergePayload<Contact>> = {}): MergePayload<Contact> {
  return {
    contacts: over.contacts ?? [contact("a"), contact("b")],
    emails: over.emails ?? [],
    phones: over.phones ?? [],
    memberships: over.memberships ?? [],
  };
}

/** A selection with nothing kept, for tests that only care about one part. */
const emptySelection = (over: Partial<MergeSelection> = {}): MergeSelection => ({
  primaryId: "a",
  fieldChoice: {},
  notesSource: null,
  keepEmails: new Set(),
  keepPhones: new Set(),
  primaryEmail: null,
  primaryPhone: null,
  excludedGroups: new Set(),
  ...over,
});

describe("seedMergeSelection", () => {
  it("returns null for an empty payload rather than inventing a survivor", () => {
    expect(seedMergeSelection(payload({ contacts: [] }))).toBeNull();
  });

  it("survives on the first contact when the user has not picked one", () => {
    const seeded = seedMergeSelection(payload({ contacts: [contact("a"), contact("b")] }));
    expect(seeded?.primaryId).toBe("a");
  });

  it("keeps the user's existing survivor across a payload reload", () => {
    const seeded = seedMergeSelection(payload({ contacts: [contact("a"), contact("b")] }), "b");
    expect(seeded?.primaryId).toBe("b");
  });

  it("takes the survivor's value for a field it fills", () => {
    const seeded = seedMergeSelection(
      payload({
        contacts: [contact("a", { name: "Ada Lovelace" }), contact("b", { name: "A. Lovelace" })],
      }),
    );
    expect(seeded?.fieldChoice.name).toBe("a");
  });

  it("falls through to the first other contact that fills a field the survivor leaves blank", () => {
    const seeded = seedMergeSelection(
      payload({
        contacts: [
          contact("a", { name: "Ada" }),
          contact("b", { title: null }),
          contact("c", { title: "CTO" }),
        ],
      }),
    );
    expect(seeded?.fieldChoice.title).toBe("c");
    expect(seeded?.fieldChoice.name).toBe("a");
  });

  it("respects payload order, not id order, when falling through", () => {
    const seeded = seedMergeSelection(
      payload({
        contacts: [contact("a"), contact("z", { city: "Lisbon" }), contact("b", { city: "Porto" })],
      }),
    );
    expect(seeded?.fieldChoice.city).toBe("z");
  });

  it("leaves a field no contact fills unassigned, rather than pointing it at an empty value", () => {
    const seeded = seedMergeSelection(payload());
    expect(seeded?.fieldChoice).toStrictEqual({});
  });

  it("treats an empty string as no value at all, so a filled contact wins", () => {
    const seeded = seedMergeSelection(
      payload({ contacts: [contact("a", { company: "" }), contact("b", { company: "Acme" })] }),
    );
    expect(seeded?.fieldChoice.company).toBe("b");
  });

  it("only seeds fields the merge dialog actually offers", () => {
    const seeded = seedMergeSelection(
      payload({ contacts: [contact("a", { name: "Ada", notes: "private" })] }),
    );
    const offered = new Set(SCALAR_FIELDS.map((f) => f.key));
    expect(Object.keys(seeded?.fieldChoice ?? {}).every((k) => offered.has(k))).toBe(true);
    // Notes are decrypted separately and are never a scalar choice.
    expect(seeded?.fieldChoice).not.toHaveProperty("notes");
  });

  it("prefers the survivor's notes when it has any", () => {
    const seeded = seedMergeSelection(
      payload({
        contacts: [contact("a", { notes: "from a" }), contact("b", { notes: "from b" })],
      }),
    );
    expect(seeded?.notesSource).toBe("a");
  });

  it("takes another contact's notes when the survivor has none", () => {
    const seeded = seedMergeSelection(
      payload({ contacts: [contact("a"), contact("b", { notes: "from b" })] }),
    );
    expect(seeded?.notesSource).toBe("b");
  });

  it("points notes at the survivor when nobody has any", () => {
    const seeded = seedMergeSelection(payload(), "b");
    expect(seeded?.notesSource).toBe("b");
  });

  it("keeps every email and phone by default, so a merge drops no contact method", () => {
    const seeded = seedMergeSelection(
      payload({
        emails: [email("e1", "a"), email("e2", "b")],
        phones: [phone("p1", "a"), phone("p2", "b")],
      }),
    );
    expect([...(seeded?.keepEmails ?? [])].sort()).toStrictEqual(["e1", "e2"]);
    expect([...(seeded?.keepPhones ?? [])].sort()).toStrictEqual(["p1", "p2"]);
  });

  it("promotes the survivor's own primary email and phone", () => {
    const seeded = seedMergeSelection(
      payload({
        emails: [email("e1", "b", { is_primary: true }), email("e2", "a", { is_primary: true })],
        phones: [phone("p1", "b", { is_primary: true }), phone("p2", "a", { is_primary: true })],
      }),
    );
    expect(seeded?.primaryEmail).toBe("e2");
    expect(seeded?.primaryPhone).toBe("p2");
  });

  it("falls back to the survivor's first entry when none of its own is marked primary", () => {
    const seeded = seedMergeSelection(
      payload({
        emails: [email("e1", "b", { is_primary: true }), email("e2", "a"), email("e3", "a")],
      }),
    );
    expect(seeded?.primaryEmail).toBe("e2");
  });

  it("falls back to any contact's first entry when the survivor has none of its own", () => {
    const seeded = seedMergeSelection(
      payload({ emails: [email("e1", "b"), email("e2", "b")], phones: [phone("p1", "b")] }),
    );
    expect(seeded?.primaryEmail).toBe("e1");
    expect(seeded?.primaryPhone).toBe("p1");
  });

  it("leaves the primary email and phone unset when there are none at all", () => {
    const seeded = seedMergeSelection(payload());
    expect(seeded?.primaryEmail).toBeNull();
    expect(seeded?.primaryPhone).toBeNull();
  });

  it("starts with every group included", () => {
    const seeded = seedMergeSelection(
      payload({ memberships: [{ group_id: "g1" }, { group_id: "g2" }] }),
    );
    expect(seeded?.excludedGroups.size).toBe(0);
  });
});

describe("buildMergeRequest", () => {
  it("refuses to build a request with no survivor", () => {
    expect(() => buildMergeRequest(payload(), emptySelection({ primaryId: null }))).toThrow(
      "No primary selected",
    );
  });

  it("names every other contact as a loser", () => {
    const p = payload({ contacts: [contact("a"), contact("b"), contact("c")] });
    const req = buildMergeRequest(p, emptySelection({ primaryId: "b" }));
    expect(req.primaryId).toBe("b");
    expect(req.loserIds).toStrictEqual(["a", "c"]);
  });

  it("resolves each chosen field to that contact's value", () => {
    const p = payload({
      contacts: [contact("a", { name: "Ada", city: "Lisbon" }), contact("b", { name: "A. L." })],
    });
    const req = buildMergeRequest(p, emptySelection({ fieldChoice: { name: "b", city: "a" } }));
    expect(req.fields).toStrictEqual({ name: "A. L.", city: "Lisbon" });
  });

  it("sends an explicitly chosen empty field as null rather than dropping it", () => {
    const p = payload({ contacts: [contact("a"), contact("b", { title: "CTO" })] });
    const req = buildMergeRequest(p, emptySelection({ fieldChoice: { title: "a" } }));
    expect(req.fields).toStrictEqual({ title: null });
  });

  it("sends null for a field pointed at a contact that is no longer in the payload", () => {
    const req = buildMergeRequest(payload(), emptySelection({ fieldChoice: { name: "gone" } }));
    expect(req.fields).toStrictEqual({ name: null });
  });

  it("locks only the fields that ended up with a real value", () => {
    const p = payload({
      contacts: [contact("a", { name: "Ada", company: "" }), contact("b", { title: "CTO" })],
    });
    const req = buildMergeRequest(
      p,
      emptySelection({ fieldChoice: { name: "a", title: "b", company: "a", city: "a" } }),
    );
    expect(req.manualLockFields.sort()).toStrictEqual(["name", "title"]);
    // The unlocked fields are still sent, just not locked against enrichment.
    // An empty-string source is carried through as "" (only ?? guards null),
    // while an absent one becomes null.
    expect(req.fields).toStrictEqual({ name: "Ada", title: "CTO", company: "", city: null });
  });

  it("sends only the kept emails and phones", () => {
    const p = payload({
      emails: [email("e1", "a"), email("e2", "b")],
      phones: [phone("p1", "a"), phone("p2", "b")],
    });
    const req = buildMergeRequest(
      p,
      emptySelection({ keepEmails: new Set(["e2"]), keepPhones: new Set(["p1"]) }),
    );
    expect(req.emails).toStrictEqual([
      { label: "work", address: "e2@acme.com", is_primary: false },
    ]);
    expect(req.phones).toStrictEqual([{ label: "mobile", number: "555-p1", is_primary: false }]);
  });

  it("marks exactly the chosen entry as primary, ignoring the source rows' own flags", () => {
    const p = payload({
      emails: [email("e1", "a", { is_primary: true }), email("e2", "b", { is_primary: true })],
    });
    const req = buildMergeRequest(
      p,
      emptySelection({ keepEmails: new Set(["e1", "e2"]), primaryEmail: "e2" }),
    );
    expect(req.emails.map((e) => [e.address, e.is_primary])).toStrictEqual([
      ["e1@acme.com", false],
      ["e2@acme.com", true],
    ]);
  });

  // Unchecking the entry that was primary leaves the survivor with no primary
  // email at all — nothing re-promotes another.
  it("sends no primary email when the chosen one was unchecked", () => {
    const p = payload({ emails: [email("e1", "a"), email("e2", "b")] });
    const req = buildMergeRequest(
      p,
      emptySelection({ keepEmails: new Set(["e1"]), primaryEmail: "e2" }),
    );
    expect(req.emails).toStrictEqual([
      { label: "work", address: "e1@acme.com", is_primary: false },
    ]);
  });

  it("carries the excluded groups through as a plain array", () => {
    const req = buildMergeRequest(
      payload(),
      emptySelection({ excludedGroups: new Set(["g1", "g2"]) }),
    );
    expect(req.excludedGroupIds).toStrictEqual(["g1", "g2"]);
  });

  it("carries the notes source through untouched", () => {
    const req = buildMergeRequest(payload(), emptySelection({ notesSource: "b" }));
    expect(req.notesSource).toBe("b");
  });

  it("round-trips the seeded defaults into a request that keeps everything", () => {
    const p = payload({
      contacts: [contact("a", { name: "Ada" }), contact("b", { title: "CTO", notes: "call her" })],
      emails: [email("e1", "a", { is_primary: true })],
      phones: [phone("p1", "b")],
      memberships: [{ group_id: "g1" }],
    });
    const seeded = seedMergeSelection(p);
    if (!seeded) throw new Error("expected a seeded selection");
    const req = buildMergeRequest(p, seeded);

    expect(req).toStrictEqual({
      primaryId: "a",
      loserIds: ["b"],
      fields: { name: "Ada", title: "CTO" },
      notesSource: "b",
      emails: [{ label: "work", address: "e1@acme.com", is_primary: true }],
      phones: [{ label: "mobile", number: "555-p1", is_primary: true }],
      excludedGroupIds: [],
      manualLockFields: ["name", "title"],
    });
  });
});

describe("unionGroupIds", () => {
  it("dedupes group ids across contacts, keeping first-seen order", () => {
    expect(
      unionGroupIds([
        { group_id: "g2" },
        { group_id: "g1" },
        { group_id: "g2" },
        { group_id: "g3" },
      ]),
    ).toStrictEqual(["g2", "g1", "g3"]);
  });

  it("is empty when no contact belongs to a group", () => {
    expect(unionGroupIds([])).toStrictEqual([]);
  });
});
