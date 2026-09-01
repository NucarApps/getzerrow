import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

describe("resolveCompanyLogoDomainForContact", () => {
  beforeEach(() => {
    fake.reset();
  });

  it("prefers the selected logo source domain across linked company aliases", async () => {
    fake.seed("company_domains", [
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
    ]);
    fake.seed("company_logo_choices", [
      {
        user_id: "user-a",
        domain: "nissan-usa.com",
        source_domain: "nissanusa.com",
      },
    ]);

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
    fake.seed("contacts", [
      { id: "contact-aditya", user_id: "user-a", company_id: "company-nissan" },
    ]);
    fake.seed("company_domains", [
      {
        user_id: "user-a",
        company_id: "company-nissan",
        domain: "nissanusa.com",
        source: "manual",
        member_count: 1,
        created_at: "2026-07-18T15:59:54.000Z",
      },
    ]);

    const { resolveCompanyLogoDomainForContact } = await import("./logo-photo.server");
    const domain = await resolveCompanyLogoDomainForContact("user-a", {
      id: "contact-aditya",
      email: "aditya.jairaj@nissan-usa.com",
      website: null,
    });

    expect(domain).toBe("nissanusa.com");
  });
});
