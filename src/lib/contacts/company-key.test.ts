import { describe, expect, it } from "vitest";
import { deriveCompanyKey, type CompanyKeyContext } from "./company-key";

const EMPTY_CTX: CompanyKeyContext = {
  domainAliases: null,
  companiesById: null,
  nameAliases: null,
  companyIdByDomain: null,
};

function ctx(overrides: Partial<CompanyKeyContext>): CompanyKeyContext {
  return { ...EMPTY_CTX, ...overrides };
}

function contact(overrides: {
  company?: string | null;
  email?: string | null;
  website?: string | null;
  company_id?: string | null;
}) {
  return {
    company: overrides.company ?? null,
    email: overrides.email ?? null,
    website: overrides.website ?? null,
    company_id: overrides.company_id ?? null,
  };
}

describe("deriveCompanyKey", () => {
  it("collapses fragmented company rows into one key", () => {
    const companiesById = new Map([
      ["c1", "Nissan"],
      ["c2", "Nissan North America"],
      ["c3", "Nissan-USA"],
    ]);
    const keys = ["c1", "c2", "c3"].map(
      (company_id) => deriveCompanyKey(contact({ company_id }), ctx({ companiesById }))?.key,
    );
    expect(keys).toEqual(["nissan", "nissan", "nissan"]);
  });

  it("keeps dealers separate from the factory brand", () => {
    const companiesById = new Map([
      ["c1", "Nissan North America"],
      ["c2", "Nissan Of Keene"],
    ]);
    const factory = deriveCompanyKey(contact({ company_id: "c1" }), ctx({ companiesById }));
    const dealer = deriveCompanyKey(contact({ company_id: "c2" }), ctx({ companiesById }));
    expect(factory?.key).toBe("nissan");
    expect(dealer?.key).toBe("nissan of keene");
  });

  it("resolves merged-away names through company_name_aliases", () => {
    const companiesById = new Map([["c4", "Nissan Motor Acceptance Company"]]);
    const nameAliases = new Map([["nissan motor acceptance company", "Nissan"]]);
    const derived = deriveCompanyKey(
      contact({ company_id: "c4" }),
      ctx({ companiesById, nameAliases }),
    );
    expect(derived?.key).toBe("nissan");
    expect(derived?.displayName).toBe("Nissan");
    expect(derived?.fromCompany).toBe(true);
  });

  it("derives from free-text company when no entity is linked", () => {
    const derived = deriveCompanyKey(contact({ company: "Nissan North America" }), EMPTY_CTX);
    expect(derived?.key).toBe("nissan");
    expect(derived?.fromCompany).toBe(false);
  });

  it("resolves free-text through name aliases", () => {
    const nameAliases = new Map([["nissan motor acceptance company", "Nissan"]]);
    const derived = deriveCompanyKey(
      contact({ company: "Nissan Motor Acceptance Company" }),
      ctx({ nameAliases }),
    );
    expect(derived?.key).toBe("nissan");
    expect(derived?.displayName).toBe("Nissan");
  });

  it("maps a known company domain into that company's bucket", () => {
    const companiesById = new Map([["c1", "Nissan"]]);
    const companyIdByDomain = new Map([["nissan-usa.com", "c1"]]);
    const derived = deriveCompanyKey(
      contact({ email: "gary.floyd@nissan-usa.com" }),
      ctx({ companiesById, companyIdByDomain }),
    );
    expect(derived?.key).toBe("nissan");
    expect(derived?.displayName).toBe("Nissan");
    expect(derived?.rawCompany).toBeNull();
  });

  it("falls back to a pretty domain name for unknown domains", () => {
    const derived = deriveCompanyKey(contact({ email: "someone@nissan-usa.com" }), EMPTY_CTX);
    // "nissan-usa.com" → "Nissan-usa" → normalized "nissan"
    expect(derived?.key).toBe("nissan");
    expect(derived?.fromCompany).toBe(false);
  });

  it("ignores personal email domains", () => {
    expect(deriveCompanyKey(contact({ email: "someone@gmail.com" }), EMPTY_CTX)).toBeNull();
  });
});
