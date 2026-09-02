import { describe, expect, it } from "vitest";
import {
  companyFormFromRow,
  companyUpdatePayload,
  discoverDomainsSummary,
  EMPTY_COMPANY_FORM,
  logoChoiceFor,
  mergeCandidates,
  photoPriorityDisplay,
  primaryDomainOf,
  tagsAfterAdd,
  tagsAfterRemove,
  type CompanyForm,
} from "./company-form";

function form(over: Partial<CompanyForm> = {}): CompanyForm {
  return { ...EMPTY_COMPANY_FORM, name: "Acme", ...over };
}

describe("companyFormFromRow", () => {
  it("copies every field across", () => {
    expect(
      companyFormFromRow({
        name: "Acme",
        website: "https://acme.test",
        phone: "+1 555 0100",
        address_line1: "1 Main St",
        address_line2: "Suite 4",
        city: "Springfield",
        region: "IL",
        postal_code: "62701",
        country: "US",
        industry: "Manufacturing",
        description: "Rockets.",
      }),
    ).toStrictEqual({
      name: "Acme",
      website: "https://acme.test",
      phone: "+1 555 0100",
      address_line1: "1 Main St",
      address_line2: "Suite 4",
      city: "Springfield",
      region: "IL",
      postal_code: "62701",
      country: "US",
      industry: "Manufacturing",
      description: "Rockets.",
    });
  });

  it("turns every null column into an empty box", () => {
    // A controlled input handed null switches to uncontrolled and React warns
    // on the first keystroke.
    expect(companyFormFromRow({ name: "Acme", phone: null })).toStrictEqual(form({ name: "Acme" }));
  });

  it("treats a column the row does not carry as empty", () => {
    expect(companyFormFromRow({ name: "Acme" })).toStrictEqual(form());
  });

  it("returns a blank form for no company at all", () => {
    expect(companyFormFromRow(null)).toStrictEqual(EMPTY_COMPANY_FORM);
    expect(companyFormFromRow(undefined)).toStrictEqual(EMPTY_COMPANY_FORM);
  });

  it("does not hand back the shared blank constant", () => {
    const a = companyFormFromRow(null);
    expect(a).not.toBe(EMPTY_COMPANY_FORM);
  });
});

describe("companyUpdatePayload", () => {
  it("sends every filled field as written", () => {
    expect(
      companyUpdatePayload("co-1", form({ website: "https://acme.test", city: "Springfield" })),
    ).toStrictEqual({
      id: "co-1",
      name: "Acme",
      website: "https://acme.test",
      phone: null,
      address_line1: null,
      address_line2: null,
      city: "Springfield",
      region: null,
      postal_code: null,
      country: null,
      industry: null,
      description: null,
    });
  });

  it("sends an emptied field as null so clearing it sticks", () => {
    // null means CLEAR to the writer. Sending undefined would leave the old
    // value in place and the field would silently reappear on reload.
    expect(companyUpdatePayload("co-1", form({ phone: "" })).phone).toBeNull();
  });

  it.each([
    "website",
    "phone",
    "address_line1",
    "address_line2",
    "city",
    "region",
    "postal_code",
    "country",
    "industry",
    "description",
  ] as const)("clears %s with null rather than skipping it", (field) => {
    expect(companyUpdatePayload("co-1", form())[field]).toBeNull();
  });

  it("sends an emptied NAME as undefined so it is left alone", () => {
    // The deliberate exception: a company must always have a name, and a
    // cleared box saved as null would leave a row no list view can label.
    const payload = companyUpdatePayload("co-1", form({ name: "" }));
    expect(payload.name).toBeUndefined();
    expect("name" in payload).toBe(true);
  });

  it("carries the id it was given", () => {
    expect(companyUpdatePayload("co-9", form()).id).toBe("co-9");
  });
});

describe("discoverDomainsSummary", () => {
  it("reports new and refreshed domains together", () => {
    expect(discoverDomainsSummary({ added: 2, updated: 3 })).toBe(
      "Discovered domains: 2 new, 3 refreshed",
    );
  });

  it("reports only what actually happened", () => {
    expect(discoverDomainsSummary({ added: 2, updated: 0 })).toBe("Discovered domains: 2 new");
    expect(discoverDomainsSummary({ added: 0, updated: 3 })).toBe(
      "Discovered domains: 3 refreshed",
    );
  });

  it("says nothing was found when neither count moved", () => {
    expect(discoverDomainsSummary({ added: 0, updated: 0 })).toBe("No new domains found");
    expect(discoverDomainsSummary({})).toBe("No new domains found");
  });
});

describe("mergeCandidates", () => {
  const companies = [{ id: "co-1" }, { id: "co-2" }, { id: "co-3" }];

  it("excludes the company being viewed", () => {
    // Merging a company into itself would delete it as the source side.
    expect(mergeCandidates(companies, "co-2").map((c) => c.id)).toStrictEqual(["co-1", "co-3"]);
  });

  it("keeps everything when the current company is not in the list", () => {
    expect(mergeCandidates(companies, "co-gone")).toHaveLength(3);
  });

  it("returns nothing when there is only this company", () => {
    expect(mergeCandidates([{ id: "co-1" }], "co-1")).toStrictEqual([]);
  });
});

describe("primaryDomainOf", () => {
  it("takes the first domain", () => {
    expect(primaryDomainOf([{ domain: "acme.test" }, { domain: "acme.co" }])).toBe("acme.test");
  });

  it("returns null for a company with no domains", () => {
    expect(primaryDomainOf([])).toBeNull();
    expect(primaryDomainOf(null)).toBeNull();
    expect(primaryDomainOf(undefined)).toBeNull();
  });

  it("returns null when the first row's domain is itself null", () => {
    expect(primaryDomainOf([{ domain: null }])).toBeNull();
  });
});

describe("logoChoiceFor", () => {
  const choices = [
    { domain: "acme.test", provider: 2, source_domain: "acmecorp.test" },
    { domain: "globex.test", provider: 1, source_domain: null },
  ];

  it("returns both halves of the matching choice", () => {
    expect(logoChoiceFor("acme.test", choices)).toStrictEqual({
      provider: 2,
      sourceDomain: "acmecorp.test",
    });
  });

  it("returns a provider with no source domain when the row has none", () => {
    expect(logoChoiceFor("globex.test", choices)).toStrictEqual({
      provider: 1,
      sourceDomain: null,
    });
  });

  it("returns neither half when no choice matches", () => {
    // Both come from the same row or neither does — mixing them would ask the
    // proxy for a logo that does not exist.
    expect(logoChoiceFor("unknown.test", choices)).toStrictEqual({
      provider: null,
      sourceDomain: null,
    });
  });

  it("returns neither half for a company with no primary domain", () => {
    expect(logoChoiceFor(null, choices)).toStrictEqual({ provider: null, sourceDomain: null });
  });

  it("returns neither half while the choices are still loading", () => {
    expect(logoChoiceFor("acme.test", undefined)).toStrictEqual({
      provider: null,
      sourceDomain: null,
    });
  });
});

describe("photoPriorityDisplay", () => {
  it.each(["company_first", "personal_first", "personal_only"] as const)(
    "reports an explicit %s as coming from the company",
    (value) => {
      expect(photoPriorityDisplay(value)).toStrictEqual({
        override: value,
        effective: value,
        source: "company",
      });
    },
  );

  it("marks an explicitly chosen company_first as the company's own choice", () => {
    // Deriving `source` from "does effective equal the default" would show a
    // company that deliberately picked company_first as merely inheriting it.
    expect(photoPriorityDisplay("company_first").source).toBe("company");
  });

  it("falls back to company_first, attributed to the default", () => {
    expect(photoPriorityDisplay(null)).toStrictEqual({
      override: null,
      effective: "company_first",
      source: "default",
    });
    expect(photoPriorityDisplay(undefined).source).toBe("default");
  });
});

describe("tagsAfterAdd", () => {
  it("appends the typed tag, lower-cased", () => {
    expect(tagsAfterAdd(["vendor"], "Partner")).toStrictEqual(["vendor", "partner"]);
  });

  it("trims the input", () => {
    expect(tagsAfterAdd([], "  partner  ")).toStrictEqual(["partner"]);
  });

  it.each([
    ["an empty box", ""],
    ["only spaces", "   "],
  ])("does nothing for %s", (_label, input) => {
    expect(tagsAfterAdd(["vendor"], input)).toBeNull();
  });

  it("does not deduplicate — the writer collapses repeats", () => {
    expect(tagsAfterAdd(["vendor"], "Vendor")).toStrictEqual(["vendor", "vendor"]);
  });

  it("does not mutate the list it was given", () => {
    const tags = ["vendor"];
    tagsAfterAdd(tags, "partner");
    expect(tags).toStrictEqual(["vendor"]);
  });
});

describe("tagsAfterRemove", () => {
  it("drops the named tag", () => {
    expect(tagsAfterRemove(["vendor", "partner"], "vendor")).toStrictEqual(["partner"]);
  });

  it("drops every copy if the list somehow holds two", () => {
    expect(tagsAfterRemove(["vendor", "vendor", "partner"], "vendor")).toStrictEqual(["partner"]);
  });

  it("leaves the list alone for a tag that is not on it", () => {
    expect(tagsAfterRemove(["vendor"], "partner")).toStrictEqual(["vendor"]);
  });

  it("removes the last tag down to an empty list", () => {
    expect(tagsAfterRemove(["vendor"], "vendor")).toStrictEqual([]);
  });
});
