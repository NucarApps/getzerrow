import { describe, expect, it } from "vitest";
import {
  buildAliasesByPrimary,
  buildAliasMap,
  buildCompanyBuckets,
  buildCompanyById,
  buildCompanyIdByDomain,
  OTHER_KEY,
  PERSONAL_KEY,
  type Bucket,
  type BucketContact,
  type CompanySummary,
} from "./contact-buckets";

function contact(over: Partial<BucketContact> & { id: string }): BucketContact {
  return { email: null, website: null, company: null, company_id: null, ...over };
}

function bucketOf(buckets: readonly Bucket[], key: string): Bucket {
  const b = buckets.find((x) => x.key === key);
  if (!b) throw new Error(`no bucket ${key} in ${buckets.map((x) => x.key).join(", ")}`);
  return b;
}

function build(
  contacts: readonly BucketContact[],
  over: {
    aliasMap?: Map<string, string>;
    companyById?: Map<string, CompanySummary>;
    companyIdByDomain?: Map<string, string>;
  } = {},
): Bucket[] {
  return buildCompanyBuckets({
    contacts,
    aliasMap: over.aliasMap ?? new Map(),
    companyById: over.companyById ?? new Map(),
    companyIdByDomain: over.companyIdByDomain ?? new Map(),
  });
}

function shape(buckets: readonly Bucket[]) {
  return buckets.map((b) => ({
    key: b.key,
    name: b.name,
    kind: b.kind,
    domain: b.domain,
    contacts: b.contacts.map((c) => c.id),
  }));
}

describe("buildAliasMap", () => {
  it("indexes alias domains onto their primary", () => {
    expect(
      buildAliasMap([
        { alias_domain: "acme.co", primary_domain: "acme.test" },
        { alias_domain: "acme.io", primary_domain: "acme.test" },
      ]),
    ).toStrictEqual(
      new Map([
        ["acme.co", "acme.test"],
        ["acme.io", "acme.test"],
      ]),
    );
  });

  it("is empty for no aliases", () => {
    expect(buildAliasMap([]).size).toBe(0);
  });
});

describe("buildAliasesByPrimary", () => {
  it("collects every alias under its primary", () => {
    expect(
      buildAliasesByPrimary([
        { alias_domain: "acme.co", primary_domain: "acme.test" },
        { alias_domain: "acme.io", primary_domain: "acme.test" },
        { alias_domain: "gx.io", primary_domain: "globex.test" },
      ]),
    ).toStrictEqual(
      new Map([
        ["acme.test", ["acme.co", "acme.io"]],
        ["globex.test", ["gx.io"]],
      ]),
    );
  });
});

describe("buildCompanyById", () => {
  it("takes the first domain as the company's preferred one", () => {
    expect(
      buildCompanyById([
        {
          id: "co-1",
          name: "Acme",
          domains: [{ domain: "acme.test" }, { domain: "acme.co" }],
          logo_url: "https://cdn.test/acme.png",
        },
      ]),
    ).toStrictEqual(
      new Map([
        ["co-1", { name: "Acme", domain: "acme.test", logoUrl: "https://cdn.test/acme.png" }],
      ]),
    );
  });

  it("tolerates a company with no domains and no logo", () => {
    expect(buildCompanyById([{ id: "co-1", name: "Acme" }]).get("co-1")).toStrictEqual({
      name: "Acme",
      domain: null,
      logoUrl: null,
    });
  });
});

describe("buildCompanyIdByDomain", () => {
  it("indexes every domain a company owns, not just the first", () => {
    expect(
      buildCompanyIdByDomain([
        { id: "co-1", domains: [{ domain: "acme.test" }, { domain: "acme.co" }] },
      ]),
    ).toStrictEqual(
      new Map([
        ["acme.test", "co-1"],
        ["acme.co", "co-1"],
      ]),
    );
  });

  it("lower-cases the key so a mixed-case domain still resolves", () => {
    // The lookup side comes from an email address, which the mail server may
    // have cased however it liked.
    expect(
      buildCompanyIdByDomain([{ id: "co-1", domains: [{ domain: "ACME.test" }] }]),
    ).toStrictEqual(new Map([["acme.test", "co-1"]]));
  });

  it("skips a null domain row", () => {
    expect(buildCompanyIdByDomain([{ id: "co-1", domains: [{ domain: null }] }]).size).toBe(0);
  });
});

describe("buildCompanyBuckets — the per-contact ladder", () => {
  it("groups colleagues by their shared work domain", () => {
    const buckets = build([
      contact({ id: "c1", email: "dana@acme.test" }),
      contact({ id: "c2", email: "sam@acme.test" }),
    ]);
    expect(shape(buckets)).toStrictEqual([
      {
        key: "acme.test",
        name: "Acme",
        kind: "company",
        domain: "acme.test",
        contacts: ["c1", "c2"],
      },
    ]);
  });

  it("puts personal-mail contacts in one shared section", () => {
    const buckets = build([
      contact({ id: "c1", email: "dana@gmail.com" }),
      contact({ id: "c2", email: "sam@yahoo.com" }),
    ]);
    expect(shape(buckets)).toStrictEqual([
      {
        key: PERSONAL_KEY,
        name: "Personal email",
        kind: "personal",
        domain: null,
        contacts: ["c1", "c2"],
      },
    ]);
  });

  it("puts a contact with no domain and no company name in Other", () => {
    expect(shape(build([contact({ id: "c1" })]))).toStrictEqual([
      { key: OTHER_KEY, name: "Other", kind: "other", domain: null, contacts: ["c1"] },
    ]);
  });

  it("does not let a dotless host mint its own section", () => {
    // isRoutableDomain rejects it, so the contact falls through to Other.
    expect(shape(build([contact({ id: "c1", email: "root@localhost" })]))).toStrictEqual([
      { key: OTHER_KEY, name: "Other", kind: "other", domain: null, contacts: ["c1"] },
    ]);
  });

  it("groups by a typed-in company name when there is no email at all", () => {
    const buckets = build([
      contact({ id: "c1", company: "Zimmerman Advertising" }),
      contact({ id: "c2", company: "Zimmerman Advertising, Inc." }),
    ]);
    // Keyed by brand, not by the literal string, so the two spellings meet.
    expect(shape(buckets)).toStrictEqual([
      {
        key: "name:zimmerman advertising",
        name: "Zimmerman Advertising",
        kind: "company",
        domain: null,
        contacts: ["c1", "c2"],
      },
    ]);
  });

  it("prefers a member's own spelling over the name derived from the domain", () => {
    const buckets = build([
      contact({ id: "c1", email: "dana@acme.test", company: "Acme Rockets" }),
    ]);
    expect(bucketOf(buckets, "acme.test").name).toBe("Acme Rockets");
  });

  it("keeps the first real name once one member has supplied it", () => {
    const buckets = build([
      contact({ id: "c1", email: "dana@acme.test", company: "Acme Rockets" }),
      contact({ id: "c2", email: "sam@acme.test", company: "Acme Rockets Ltd" }),
    ]);
    expect(bucketOf(buckets, "acme.test").name).toBe("Acme Rockets");
  });
});

describe("buildCompanyBuckets — linked companies", () => {
  const companyById = new Map<string, CompanySummary>([
    ["co-1", { name: "Acme Corporation", domain: "acme.test", logoUrl: "https://cdn.test/a.png" }],
  ]);
  const companyIdByDomain = new Map([["acme.test", "co-1"]]);

  it("files an explicitly linked contact under the company, whatever their email", () => {
    // The whole point: a colleague with only a personal address still lands
    // with their team rather than in "Personal email".
    const buckets = build([contact({ id: "c1", email: "dana@gmail.com", company_id: "co-1" })], {
      companyById,
      companyIdByDomain,
    });
    expect(shape(buckets)).toStrictEqual([
      {
        key: "cid:co-1",
        name: "Acme Corporation",
        kind: "company",
        domain: "acme.test",
        contacts: ["c1"],
      },
    ]);
    expect(bucketOf(buckets, "cid:co-1").companyLogoUrl).toBe("https://cdn.test/a.png");
  });

  it("collapses an unlinked colleague on a claimed domain into the same section", () => {
    const buckets = build(
      [
        contact({ id: "c1", company_id: "co-1", email: "dana@gmail.com" }),
        contact({ id: "c2", email: "sam@acme.test" }),
      ],
      { companyById, companyIdByDomain },
    );
    expect(shape(buckets)).toStrictEqual([
      {
        key: "cid:co-1",
        name: "Acme Corporation",
        kind: "company",
        domain: "acme.test",
        contacts: ["c1", "c2"],
      },
    ]);
  });

  it("ignores a company_id pointing at a company that is gone", () => {
    const buckets = build(
      [contact({ id: "c1", email: "dana@globex.test", company_id: "co-gone" })],
      {
        companyById,
        companyIdByDomain,
      },
    );
    expect(shape(buckets)).toStrictEqual([
      {
        key: "globex.test",
        name: "Globex",
        kind: "company",
        domain: "globex.test",
        contacts: ["c1"],
      },
    ]);
  });

  it("never looks a personal domain up against the company index", () => {
    // Otherwise one gmail-using member of a company that had claimed gmail.com
    // would turn the whole section into a "gmail.com company".
    const buckets = build([contact({ id: "c1", email: "dana@gmail.com" })], {
      companyById: new Map([["co-2", { name: "Gmail Inc", domain: "gmail.com", logoUrl: null }]]),
      companyIdByDomain: new Map([["gmail.com", "co-2"]]),
    });
    expect(bucketOf(buckets, PERSONAL_KEY).kind).toBe("personal");
  });
});

describe("buildCompanyBuckets — domain aliases", () => {
  const aliasMap = new Map([["acme.co", "acme.test"]]);

  it("files an alias-domain address with the primary domain", () => {
    const buckets = build(
      [contact({ id: "c1", email: "dana@acme.test" }), contact({ id: "c2", email: "sam@acme.co" })],
      { aliasMap },
    );
    expect(shape(buckets)).toStrictEqual([
      {
        key: "acme.test",
        name: "Acme",
        kind: "company",
        domain: "acme.test",
        contacts: ["c1", "c2"],
      },
    ]);
  });

  it("prefers the website's domain over the email's for the section's logo domain", () => {
    const buckets = build([contact({ id: "c1", email: "dana@acme.test", website: "acme.io" })]);
    expect(bucketOf(buckets, "acme.test").domain).toBe("acme.io");
  });
});

describe("buildCompanyBuckets — folding name-keyed sections", () => {
  it("derives a domain for a name-keyed section from the website its members agree on", () => {
    const buckets = build([
      contact({ id: "c1", company: "Nucar", website: "https://nucar.test" }),
      contact({ id: "c2", company: "Nucar", website: "https://nucar.test" }),
      contact({ id: "c3", company: "Nucar", website: "https://old-nucar.test" }),
    ]);
    expect(bucketOf(buckets, "name:nucar").domain).toBe("nucar.test");
  });

  it("folds a name-keyed section into the domain section its website points at", () => {
    const buckets = build([
      contact({ id: "c1", email: "dana@nucar.test" }),
      contact({ id: "c2", company: "Nucar", website: "https://nucar.test" }),
    ]);
    expect(shape(buckets)).toStrictEqual([
      {
        key: "nucar.test",
        name: "Nucar",
        kind: "company",
        domain: "nucar.test",
        contacts: ["c1", "c2"],
      },
    ]);
  });

  it("folds a name-only section into a domain section with the same brand", () => {
    // A contact with only "Zimmerman Advertising" typed in must not mint a
    // second company row beside the real one.
    const buckets = build([
      contact({ id: "c1", email: "dana@zimmerman.test", company: "Zimmerman Advertising" }),
      contact({ id: "c2", company: "Zimmerman Advertising" }),
    ]);
    expect(shape(buckets)).toStrictEqual([
      {
        key: "zimmerman.test",
        name: "Zimmerman Advertising",
        kind: "company",
        domain: "zimmerman.test",
        contacts: ["c1", "c2"],
      },
    ]);
  });

  it("does NOT fold on brand alone once the section has domain evidence of its own", () => {
    // "Apex Group" at apexgroup.test is a different company from "Apex" at
    // apex.test even though the brand keys collide.
    const buckets = build([
      contact({ id: "c1", email: "dana@apex.test", company: "Apex" }),
      contact({ id: "c2", company: "Apex", website: "https://apexgroup.test" }),
    ]);
    expect(shape(buckets)).toStrictEqual([
      { key: "apex.test", name: "Apex", kind: "company", domain: "apex.test", contacts: ["c1"] },
      {
        key: "name:apex",
        name: "Apex",
        kind: "company",
        domain: "apexgroup.test",
        contacts: ["c2"],
      },
    ]);
  });

  it("ignores a personal website domain when deriving a section's domain", () => {
    const buckets = build([contact({ id: "c1", company: "Nucar", website: "https://gmail.com" })]);
    expect(bucketOf(buckets, "name:nucar").domain).toBeNull();
  });
});

describe("buildCompanyBuckets — ordering", () => {
  it("sorts companies A–Z and sinks the two catch-alls to the bottom", () => {
    const buckets = build([
      contact({ id: "c1" }),
      contact({ id: "c2", email: "sam@gmail.com" }),
      contact({ id: "c3", email: "zoe@zulu.test" }),
      contact({ id: "c4", email: "amy@alpha.test" }),
    ]);
    expect(buckets.map((b) => b.name)).toStrictEqual(["Alpha", "Zulu", "Personal email", "Other"]);
  });

  it("sorts case-insensitively rather than putting lower-case names last", () => {
    const buckets = build([
      contact({ id: "c1", company: "zeta corp" }),
      contact({ id: "c2", company: "Alpha corp" }),
      contact({ id: "c3", company: "beta corp" }),
    ]);
    expect(buckets.map((b) => b.name)).toStrictEqual(["Alpha corp", "beta corp", "zeta corp"]);
  });

  it("returns nothing for an empty address book", () => {
    expect(build([])).toStrictEqual([]);
  });
});
