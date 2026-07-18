import { beforeEach, describe, expect, it, vi } from "vitest";

type ContactRow = { id: string; user_id: string; company_id: string | null };
type CompanyDomainRow = {
  user_id: string;
  company_id: string;
  domain: string;
  source: string;
  member_count: number;
  created_at: string;
};
type LogoChoiceRow = { user_id: string; domain: string; source_domain: string | null };

const contactsRows: ContactRow[] = [];
const companyDomainRows: CompanyDomainRow[] = [];
const logoChoiceRows: LogoChoiceRow[] = [];

function filterRows<T extends Record<string, unknown>>(
  rows: T[],
  filters: Array<[string, unknown]>,
): T[] {
  return rows.filter((row) => filters.every(([key, value]) => row[key] === value));
}

function queryFor<T extends Record<string, unknown>>(rows: T[]) {
  const filters: Array<[string, unknown]> = [];
  const builder = {
    select() {
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return builder;
    },
    maybeSingle() {
      return Promise.resolve({ data: filterRows(rows, filters)[0] ?? null, error: null });
    },
    then(resolve: (value: { data: T[]; error: null }) => void) {
      resolve({ data: filterRows(rows, filters), error: null });
    },
  };
  return builder;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      if (table === "contacts") return queryFor(contactsRows);
      if (table === "company_domains") return queryFor(companyDomainRows);
      if (table === "company_logo_choices") return queryFor(logoChoiceRows);
      return queryFor([]);
    },
  },
}));

describe("resolveCompanyLogoDomainForContact", () => {
  beforeEach(() => {
    contactsRows.length = 0;
    companyDomainRows.length = 0;
    logoChoiceRows.length = 0;
  });

  it("prefers the selected logo source domain across linked company aliases", async () => {
    companyDomainRows.push(
      {
        user_id: "user-a",
        company_id: "company-nissan",
        domain: "nissanusa.com",
        source: "manual",
        member_count: 1,
        created_at: "2026-07-18T15:59:54.000Z",
      },
      {
        user_id: "user-a",
        company_id: "company-nissan",
        domain: "nissan-usa.com",
        source: "auto",
        member_count: 32,
        created_at: "2026-07-18T15:59:54.000Z",
      },
    );
    logoChoiceRows.push({ user_id: "user-a", domain: "nissan-usa.com", source_domain: "nissanusa.com" });

    const { resolveCompanyLogoDomainForContact } = await import("./logo-photo.server");
    const domain = await resolveCompanyLogoDomainForContact("user-a", {
      id: "contact-aditya",
      company_id: "company-nissan",
      email: "aditya.jairaj@nissan-usa.com",
      website: null,
    });

    expect(domain).toBe("nissanusa.com");
  });

  it("falls back to the linked company domain before contact email heuristics", async () => {
    contactsRows.push({ id: "contact-aditya", user_id: "user-a", company_id: "company-nissan" });
    companyDomainRows.push({
      user_id: "user-a",
      company_id: "company-nissan",
      domain: "nissanusa.com",
      source: "manual",
      member_count: 1,
      created_at: "2026-07-18T15:59:54.000Z",
    });

    const { resolveCompanyLogoDomainForContact } = await import("./logo-photo.server");
    const domain = await resolveCompanyLogoDomainForContact("user-a", {
      id: "contact-aditya",
      email: "aditya.jairaj@nissan-usa.com",
      website: null,
    });

    expect(domain).toBe("nissanusa.com");
  });
});