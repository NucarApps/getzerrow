import { describe, expect, it } from "vitest";
import {
  buildClusters,
  pickPrimary,
  truncateMembers,
  type ContactWithPhones,
} from "./dedup-clusters";

function contact(id: string, overrides: Partial<ContactWithPhones> = {}): ContactWithPhones {
  return {
    id,
    name: null,
    email: null,
    company: null,
    title: null,
    city: null,
    source: null,
    created_at: "2026-01-01T00:00:00Z",
    phones: [],
    ...overrides,
  };
}

describe("buildClusters", () => {
  it("clusters contacts sharing a normalized phone number", () => {
    const clusters = buildClusters([
      contact("a", { name: "Ann Lee", phones: ["(617) 555-0100"] }),
      contact("b", { name: "Annie Lee", phones: ["+1 617-555-0100"] }),
      contact("c", { name: "Bob Ray", phones: ["617-555-0199"] }),
    ]);
    const phone = clusters.find((c) => c.signal === "exact_phone");
    expect(phone).toBeDefined();
    expect(phone!.contacts.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("clusters same name + email local-part as name_email_local", () => {
    const clusters = buildClusters([
      contact("a", { name: "John Smith", email: "jsmith@acme.com" }),
      contact("b", { name: "John Smith", email: "jsmith@gmail.com" }),
    ]);
    expect(clusters.some((c) => c.signal === "name_email_local")).toBe(true);
  });

  it("clusters email local-part only across ≥2 domains", () => {
    const sameDomain = buildClusters([
      contact("a", { name: "Ann X", email: "info@acme.com" }),
      contact("b", { name: "Bob Y", email: "info@acme.com" }),
    ]);
    expect(sameDomain.some((c) => c.signal === "email_localpart")).toBe(false);

    const crossDomain = buildClusters([
      contact("a", { name: "Ann X", email: "jdoe@acme.com" }),
      contact("b", { name: "Bob Y", email: "jdoe@other.com" }),
    ]);
    expect(crossDomain.some((c) => c.signal === "email_localpart")).toBe(true);
  });

  it("skips name_only clusters when every row has the same email", () => {
    const clusters = buildClusters([
      contact("a", { name: "Jane Doe", email: "jane@acme.com" }),
      contact("b", { name: "Jane Doe", email: "jane@acme.com" }),
    ]);
    expect(clusters.some((c) => c.signal === "name_only")).toBe(false);
  });

  it("clusters loose first+last name variants", () => {
    const clusters = buildClusters([
      contact("a", { name: "John A Smith", email: "john.a@acme.com" }),
      contact("b", { name: "John Smith", email: "john.smith@other.com" }),
    ]);
    expect(clusters.some((c) => c.signal === "loose_name")).toBe(true);
  });

  it("labels an id-set with its strongest signal only once", () => {
    const clusters = buildClusters([
      contact("a", { name: "Ann Lee", phones: ["617-555-0100"] }),
      contact("b", { name: "Ann Lee", phones: ["617 555 0100"] }),
    ]);
    const forPair = clusters.filter((c) => c.contacts.length === 2);
    expect(forPair).toHaveLength(1);
    expect(forPair[0].signal).toBe("exact_phone");
  });

  it("never emits singleton clusters", () => {
    const clusters = buildClusters([
      contact("a", { name: "Solo Person", email: "solo@acme.com" }),
      contact("b", { name: "Other Person", email: "other@acme.com" }),
    ]);
    expect(clusters).toHaveLength(0);
  });

  it("emits overlapping-but-different id-sets as separate clusters with their own signals", () => {
    // {a,b} share a phone; {a,c} share only a name — both clusters survive.
    const clusters = buildClusters([
      contact("a", { name: "Ann Lee", email: "ann@acme.com", phones: ["617-555-0100"] }),
      contact("b", { name: "Someone Else", email: "b@x.com", phones: ["617-555-0100"] }),
      contact("c", { name: "Ann Lee", email: "ann@other.com" }),
    ]);
    const idSets = clusters.map((c) =>
      c.contacts
        .map((m) => m.id)
        .sort()
        .join(","),
    );
    expect(idSets).toContain("a,b");
    expect(idSets.some((s) => s.includes("c"))).toBe(true);
    expect(clusters.find((c) => c.signal === "exact_phone")).toBeDefined();
  });
});

describe("pickPrimary", () => {
  it("prefers a row with an email over a richer row without one", () => {
    const withEmail = contact("a", { email: "a@acme.com" });
    const richer = contact("b", {
      name: "Full Name",
      company: "Acme",
      title: "CEO",
      city: "Boston",
      phones: ["617-555-0100"],
    });
    expect(pickPrimary([richer, withEmail]).id).toBe("a");
  });

  it("breaks email ties by field richness", () => {
    const sparse = contact("a", { email: "a@acme.com" });
    const rich = contact("b", { email: "b@acme.com", name: "Named", company: "Acme" });
    expect(pickPrimary([sparse, rich]).id).toBe("b");
  });

  it("counts phones toward richness", () => {
    const noPhones = contact("a", { email: "a@acme.com", name: "Ann" });
    const withPhones = contact("b", {
      email: "b@acme.com",
      phones: ["617-555-0100", "617-555-0101"],
    });
    expect(pickPrimary([noPhones, withPhones]).id).toBe("b");
  });

  it("breaks full ties by oldest created_at", () => {
    const newer = contact("a", { created_at: "2026-02-01T00:00:00Z" });
    const older = contact("b", { created_at: "2026-01-01T00:00:00Z" });
    expect(pickPrimary([newer, older]).id).toBe("b");
  });

  it("is deterministic regardless of input order", () => {
    const a = contact("a", { email: "a@acme.com", name: "Ann" });
    const b = contact("b", { email: "b@acme.com" });
    expect(pickPrimary([a, b]).id).toBe(pickPrimary([b, a]).id);
  });
});

describe("truncateMembers", () => {
  it("keeps the same subset and primary regardless of input order", () => {
    // Regression guard: the kept subset after truncation must not depend on
    // query row order, or the dismissed-suggestion guard (keyed by primary)
    // stops matching between rescans.
    const members = ["a", "b", "c", "d", "e", "f", "g"].map((id, i) =>
      contact(id, {
        email: `${id}@acme.com`,
        created_at: `2026-01-0${i + 1}T00:00:00Z`,
      }),
    );
    const shuffled = [
      members[4],
      members[1],
      members[6],
      members[0],
      members[3],
      members[5],
      members[2],
    ];
    const t1 = truncateMembers(members, 6);
    const t2 = truncateMembers(shuffled, 6);
    expect(t1.map((c) => c.id)).toEqual(t2.map((c) => c.id));
    expect(pickPrimary(t1).id).toBe(pickPrimary(t2).id);
  });

  it("does not mutate the input array", () => {
    const members = [
      contact("b", { created_at: "2026-01-02T00:00:00Z" }),
      contact("a", { created_at: "2026-01-01T00:00:00Z" }),
    ];
    truncateMembers(members, 1);
    expect(members.map((c) => c.id)).toEqual(["b", "a"]);
  });
});
