// Unit tests for the photo/logo resolver every external contact store pushes
// through (src/lib/contacts/logo-photo.server.ts). Contracts pinned here:
//
//   - which bytes a contact syncs with, across all three photo_priority
//     orders — this is what CardDAV and Google People actually upload;
//   - the saved per-user logo pick: it is scoped to the caller, keyed on
//     either side of a domain alias pair, and a dead pick falls through to
//     the generic provider walk rather than stranding the contact;
//   - the logo-hash ledger: what recordCompanyLogoHash writes, and how
//     findMatchingCompanyLogoSha walks a company's domains × providers to
//     recognise a stale snapshot, within its fetch budget.
//
// Only the network (logo-fetch's fetchLogoBytes) and the two storage byte
// loaders are stubbed; the provider table, the cache and the SHA helper are
// the real ones. The module-level logo cache is shared by the whole file, so
// each test uses its own domain.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

type LogoHit = { bytes: Uint8Array; mime: string } | null;
const fetchLogoBytes = vi.fn<(url: string) => Promise<LogoHit>>();
vi.mock("@/lib/logo-fetch.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logo-fetch.server")>();
  return { ...actual, fetchLogoBytes: (url: string) => fetchLogoBytes(url) };
});

const loadContactPhotoBytes = vi.fn<(url: string | null) => Promise<LogoHit>>();
vi.mock("@/lib/contacts/photos.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/contacts/photos.server")>();
  return { ...actual, loadContactPhotoBytes: (url: string | null) => loadContactPhotoBytes(url) };
});

const loadCompanyPhotoBytes = vi.fn<(url: string) => Promise<LogoHit>>();
vi.mock("@/lib/companies/company-photo.server", () => ({
  loadCompanyPhotoBytes: (url: string) => loadCompanyPhotoBytes(url),
}));

import {
  fetchChosenCompanyLogoBytes,
  recordCompanyLogoHash,
  getKnownCompanyLogoHashes,
  findMatchingCompanyLogoSha,
  resolveEffectiveContactPhotoForSync,
} from "./logo-photo.server";
import { providersFor } from "@/lib/logo-fetch.server";
import { sha256Hex } from "@/lib/contacts/photos.server";

const AVATAR_BYTES = new Uint8Array([1, 2, 3, 4]);
const COMPANY_BYTES = new Uint8Array([5, 6, 7, 8]);
const LOGO_BYTES = new Uint8Array([9, 10, 11, 12]);
const png = (bytes: Uint8Array) => ({ bytes, mime: "image/png" });

/** Answer only the given URLs; everything else is a miss. */
function serveLogos(urls: Record<string, Uint8Array>) {
  fetchLogoBytes.mockImplementation(async (url) => {
    const bytes = urls[url];
    return bytes ? png(bytes) : null;
  });
}

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

describe("fetchChosenCompanyLogoBytes", () => {
  beforeEach(() => {
    fake.reset();
    fetchLogoBytes.mockResolvedValue(null);
  });

  it("uses the provider index and source domain the user picked", async () => {
    fake.seed("company_logo_choices", [
      { user_id: "user-a", domain: "chosen-a.com", provider: 2, source_domain: "brand-a.com" },
    ]);
    serveLogos({ [providersFor("brand-a.com")[2]!]: LOGO_BYTES });

    const hit = await fetchChosenCompanyLogoBytes("user-a", "Chosen-A.com");

    expect(hit).toStrictEqual(png(LOGO_BYTES));
    // Exactly the picked variant — no walk over the other providers.
    expect(fetchLogoBytes.mock.calls).toStrictEqual([[providersFor("brand-a.com")[2]!]]);
  });

  it("matches a pick stored against the other side of a domain alias pair", async () => {
    fake.seed("company_logo_choices", [
      { user_id: "user-a", domain: "chosen-b.com", provider: 1, source_domain: "brand-b.com" },
    ]);
    serveLogos({ [providersFor("brand-b.com")[1]!]: LOGO_BYTES });

    // Queried by the SOURCE domain, which is only on source_domain.
    expect(await fetchChosenCompanyLogoBytes("user-a", "brand-b.com")).toStrictEqual(
      png(LOGO_BYTES),
    );
  });

  it("ignores another user's pick and walks the providers instead", async () => {
    fake.seed("company_logo_choices", [
      { user_id: "user-b", domain: "chosen-c.com", provider: 3, source_domain: "brand-c.com" },
    ]);
    // Only the first generic provider for the queried domain answers.
    serveLogos({ [providersFor("chosen-c.com")[0]!]: LOGO_BYTES });

    expect(await fetchChosenCompanyLogoBytes("user-a", "chosen-c.com")).toStrictEqual(
      png(LOGO_BYTES),
    );
    expect(fetchLogoBytes).toHaveBeenCalledWith(providersFor("chosen-c.com")[0]!);
    expect(fetchLogoBytes).not.toHaveBeenCalledWith(providersFor("brand-c.com")[3]!);
  });

  it("falls through to the generic walk when the picked provider is dead", async () => {
    fake.seed("company_logo_choices", [
      { user_id: "user-a", domain: "chosen-d.com", provider: 4, source_domain: "brand-d.com" },
    ]);
    // The pick 404s; the second generic provider for the queried domain answers.
    serveLogos({ [providersFor("chosen-d.com")[1]!]: LOGO_BYTES });

    expect(await fetchChosenCompanyLogoBytes("user-a", "chosen-d.com")).toStrictEqual(
      png(LOGO_BYTES),
    );
    expect(fetchLogoBytes).toHaveBeenCalledWith(providersFor("brand-d.com")[4]!);
  });

  it("falls back to the walk when the pick names a provider index that no longer exists", async () => {
    fake.seed("company_logo_choices", [
      { user_id: "user-a", domain: "chosen-e.com", provider: 99, source_domain: "brand-e.com" },
    ]);
    serveLogos({ [providersFor("chosen-e.com")[0]!]: LOGO_BYTES });

    expect(await fetchChosenCompanyLogoBytes("user-a", "chosen-e.com")).toStrictEqual(
      png(LOGO_BYTES),
    );
  });

  it.each([
    ["a null domain", null],
    ["a domain with no dot", "localhost"],
    ["a reserved TLD", "acme.internal"],
    ["a bare IP literal", "127.0.0.1"],
  ])("refuses %s without touching a provider", async (_label, domain) => {
    expect(await fetchChosenCompanyLogoBytes("user-a", domain)).toBeNull();
    expect(fetchLogoBytes).not.toHaveBeenCalled();
  });
});

describe("recordCompanyLogoHash", () => {
  beforeEach(() => fake.reset());

  it("upserts on (user, company, sha) with a lowercased domain and a default source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00.000Z"));

    await recordCompanyLogoHash({
      userId: "user-a",
      companyId: "co-1",
      domain: "Nissan-USA.com",
      sha256: "abc123",
    });

    expect(fake.calls.upserts).toStrictEqual([
      {
        table: "company_logo_hashes",
        payload: {
          user_id: "user-a",
          company_id: "co-1",
          domain: "nissan-usa.com",
          sha256: "abc123",
          source: "observed",
          last_seen_at: "2026-09-03T10:00:00.000Z",
        },
        options: { onConflict: "user_id,company_id,sha256" },
        filters: [],
      },
    ]);
  });

  it.each([
    ["no company to attribute it to", { companyId: null, sha256: "abc" }],
    ["no hash to record", { companyId: "co-1", sha256: "" }],
  ])("writes nothing when there is %s", async (_label, args) => {
    await recordCompanyLogoHash({ userId: "user-a", domain: "acme.com", ...args });

    expect(fake.calls.upserts).toStrictEqual([]);
  });
});

describe("getKnownCompanyLogoHashes", () => {
  beforeEach(() => fake.reset());

  it("narrows to one company when asked, and to the user otherwise", async () => {
    fake.seed("company_logo_hashes", [
      { user_id: "user-a", company_id: "co-1", sha256: "aaa" },
      { user_id: "user-a", company_id: "co-2", sha256: "bbb" },
      { user_id: "user-b", company_id: "co-1", sha256: "ccc" },
    ]);

    expect([...(await getKnownCompanyLogoHashes("user-a", "co-1"))]).toStrictEqual(["aaa"]);
    expect([...(await getKnownCompanyLogoHashes("user-a"))].sort()).toStrictEqual(["aaa", "bbb"]);
  });
});

describe("findMatchingCompanyLogoSha", () => {
  const computeSha = (bytes: Uint8Array) => sha256Hex(bytes);

  beforeEach(() => {
    fake.reset();
    fetchLogoBytes.mockResolvedValue(null);
  });

  it("answers from the recorded ledger without fetching anything", async () => {
    fake.seed("company_logo_hashes", [
      { user_id: "user-a", company_id: "co-1", sha256: "known-sha" },
    ]);

    expect(await findMatchingCompanyLogoSha("user-a", "co-1", "known-sha", computeSha)).toBe(
      "known-sha",
    );
    expect(fetchLogoBytes).not.toHaveBeenCalled();
  });

  it("returns null for a company with no linked domains", async () => {
    expect(await findMatchingCompanyLogoSha("user-a", "co-1", "target", computeSha)).toBeNull();
    expect(fetchLogoBytes).not.toHaveBeenCalled();
  });

  it("walks the manual domain first and records the hash it recognises", async () => {
    fake.seed("company_domains", [
      {
        user_id: "user-a",
        company_id: "co-1",
        domain: "auto-f.com",
        source: "auto",
        member_count: 50,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        user_id: "user-a",
        company_id: "co-1",
        domain: "manual-f.com",
        source: "manual",
        member_count: 1,
        created_at: "2026-01-02T00:00:00Z",
      },
    ]);
    // Only the manual domain's third provider answers.
    serveLogos({ [providersFor("manual-f.com")[2]!]: LOGO_BYTES });
    const target = await sha256Hex(LOGO_BYTES);

    expect(await findMatchingCompanyLogoSha("user-a", "co-1", target, computeSha)).toBe(target);

    // The manual domain was tried first, and the auto domain never reached.
    expect(fetchLogoBytes.mock.calls.map((c) => c[0])).toStrictEqual(
      providersFor("manual-f.com").slice(0, 3),
    );
    expect(fake.calls.upserts[0]?.payload).toMatchObject({
      company_id: "co-1",
      domain: "manual-f.com",
      sha256: target,
      source: "provider_probe",
    });
  });

  it("skips a blocked domain and returns null when nothing matches", async () => {
    fake.seed("company_domains", [
      { user_id: "user-a", company_id: "co-1", domain: "acme.internal", source: "manual" },
      { user_id: "user-a", company_id: "co-1", domain: "other-g.com", source: "auto" },
    ]);
    serveLogos({ [providersFor("other-g.com")[0]!]: LOGO_BYTES });

    expect(
      await findMatchingCompanyLogoSha("user-a", "co-1", "some-other-sha", computeSha),
    ).toBeNull();
    expect(fetchLogoBytes).not.toHaveBeenCalledWith(providersFor("acme.internal")[0]!);
    expect(fake.calls.upserts).toStrictEqual([]);
  });

  it("stops after the 20-fetch budget rather than walking every domain", async () => {
    fake.seed(
      "company_domains",
      Array.from({ length: 6 }, (_, i) => ({
        user_id: "user-a",
        company_id: "co-1",
        domain: `budget-${i}.com`,
        source: "auto",
        member_count: 6 - i,
      })),
    );

    expect(await findMatchingCompanyLogoSha("user-a", "co-1", "nope", computeSha)).toBeNull();
    // 6 domains × 7 providers = 42 candidates, capped at 20 attempts.
    expect(fetchLogoBytes).toHaveBeenCalledTimes(20);
  });
});

describe("resolveEffectiveContactPhotoForSync", () => {
  const CONTACT = "contact-1";
  const COMPANY = "co-1";

  function seedContact(over: Record<string, unknown> = {}) {
    fake.seed("contacts", [
      {
        id: CONTACT,
        user_id: "user-a",
        avatar_url: "https://storage.test/contact-photos/a.png",
        company_id: COMPANY,
        website: null,
        email: "someone@brand-h.com",
        ...over,
      },
    ]);
  }

  beforeEach(() => {
    fake.reset();
    fetchLogoBytes.mockResolvedValue(null);
    loadContactPhotoBytes.mockResolvedValue(png(AVATAR_BYTES));
    loadCompanyPhotoBytes.mockResolvedValue(png(COMPANY_BYTES));
  });

  it("returns null for a contact that is not the caller's", async () => {
    seedContact({ user_id: "user-b" });

    expect(await resolveEffectiveContactPhotoForSync("user-a", CONTACT)).toBeNull();
  });

  it("company_first (the default) pushes the company's uploaded logo and records its hash", async () => {
    seedContact();
    fake.seed("companies", [
      { id: COMPANY, user_id: "user-a", logo_url: "https://storage.test/company-photos/c.png" },
    ]);
    const sha = await sha256Hex(COMPANY_BYTES);

    const photo = await resolveEffectiveContactPhotoForSync("user-a", CONTACT);

    expect(photo).toStrictEqual({
      bytes: COMPANY_BYTES,
      mime: "image/png",
      etag: `company-photo:${COMPANY}:${sha}`,
      source: "company_photo",
      avatarUrl: "https://storage.test/contact-photos/a.png",
      companyId: COMPANY,
      companyLogoUrl: "https://storage.test/company-photos/c.png",
      domain: null,
      sha256: sha,
    });
    expect(fake.calls.upserts[0]?.payload).toMatchObject({
      company_id: COMPANY,
      sha256: sha,
      source: "google_push_company_photo",
    });
    expect(loadContactPhotoBytes).not.toHaveBeenCalled();
  });

  it("company_first falls to the domain logo when the company has no uploaded photo", async () => {
    seedContact();
    fake.seed("companies", [{ id: COMPANY, user_id: "user-a", logo_url: null }]);
    fake.seed("company_domains", [
      { user_id: "user-a", company_id: COMPANY, domain: "brand-h.com", source: "manual" },
    ]);
    serveLogos({ [providersFor("brand-h.com")[0]!]: LOGO_BYTES });
    const sha = await sha256Hex(LOGO_BYTES);

    const photo = await resolveEffectiveContactPhotoForSync("user-a", CONTACT);

    expect(photo).toStrictEqual({
      bytes: LOGO_BYTES,
      mime: "image/png",
      etag: `company-domain-logo:${COMPANY}:brand-h.com:${sha}`,
      source: "company_domain_logo",
      avatarUrl: "https://storage.test/contact-photos/a.png",
      companyId: COMPANY,
      companyLogoUrl: null,
      domain: "brand-h.com",
      sha256: sha,
    });
    expect(loadCompanyPhotoBytes).not.toHaveBeenCalled();
  });

  it("company_first falls all the way back to the contact's own portrait", async () => {
    seedContact({ email: "someone@gmail.com", company_id: null });

    const photo = await resolveEffectiveContactPhotoForSync("user-a", CONTACT);

    expect(photo).toMatchObject({
      bytes: AVATAR_BYTES,
      source: "contact_avatar",
      etag: "https://storage.test/contact-photos/a.png",
      companyId: null,
      domain: null,
      sha256: null,
    });
  });

  it("personal_first prefers the portrait even when a company logo exists", async () => {
    seedContact({ photo_priority: "personal_first" });
    fake.seed("companies", [
      { id: COMPANY, user_id: "user-a", logo_url: "https://storage.test/company-photos/c.png" },
    ]);

    const photo = await resolveEffectiveContactPhotoForSync("user-a", CONTACT);

    expect(photo).toMatchObject({ source: "contact_avatar", bytes: AVATAR_BYTES });
    expect(loadCompanyPhotoBytes).not.toHaveBeenCalled();
  });

  it("personal_first still inherits the company logo when the portrait cannot be read", async () => {
    seedContact({ photo_priority: "personal_first" });
    fake.seed("companies", [
      { id: COMPANY, user_id: "user-a", logo_url: "https://storage.test/company-photos/c.png" },
    ]);
    loadContactPhotoBytes.mockResolvedValue(null);

    const photo = await resolveEffectiveContactPhotoForSync("user-a", CONTACT);

    expect(photo).toMatchObject({ source: "company_photo", bytes: COMPANY_BYTES });
  });

  it("personal_only never inherits a company logo, even with none of its own", async () => {
    seedContact({ photo_priority: "personal_only", avatar_url: null });
    fake.seed("companies", [
      { id: COMPANY, user_id: "user-a", logo_url: "https://storage.test/company-photos/c.png" },
    ]);

    expect(await resolveEffectiveContactPhotoForSync("user-a", CONTACT)).toBeNull();
    expect(loadCompanyPhotoBytes).not.toHaveBeenCalled();
    expect(fetchLogoBytes).not.toHaveBeenCalled();
  });

  it("takes the company's photo_priority override when the contact has none", async () => {
    seedContact();
    fake.seed("companies", [
      {
        id: COMPANY,
        user_id: "user-a",
        photo_priority: "personal_first",
        logo_url: "https://storage.test/company-photos/c.png",
      },
    ]);

    expect(await resolveEffectiveContactPhotoForSync("user-a", CONTACT)).toMatchObject({
      source: "contact_avatar",
    });
  });

  it("takes the account-wide CardDAV default when neither contact nor company overrides", async () => {
    seedContact();
    fake.seed("companies", [
      { id: COMPANY, user_id: "user-a", logo_url: "https://storage.test/company-photos/c.png" },
    ]);
    fake.seed("carddav_settings", [{ user_id: "user-a", photo_priority: "personal_only" }]);

    expect(await resolveEffectiveContactPhotoForSync("user-a", CONTACT)).toMatchObject({
      source: "contact_avatar",
    });
    expect(loadCompanyPhotoBytes).not.toHaveBeenCalled();
  });

  it("returns null when the contact has no portrait and no logo can be found", async () => {
    seedContact({ avatar_url: null, email: "someone@gmail.com", company_id: null });

    expect(await resolveEffectiveContactPhotoForSync("user-a", CONTACT)).toBeNull();
  });
});
