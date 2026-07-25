// company-logo-cleanup.functions.ts had no test file at all, despite doing the
// most destructive thing in the logo stack: deleting a contact's stored avatar
// and writing a permanent company_logo_hashes row.
//
// Grep contracts, same style as photo-echo-decision.test.ts. They pin the two
// properties that are easy to regress by editing the file and impossible to
// see from its own source in isolation.
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

const read = (rel: string) => fs.readFile(path.resolve(process.cwd(), rel), "utf8");

const CLEANUP = "src/lib/contacts/company-logo-cleanup.functions.ts";
const KNOWN_LOGOS = "src/lib/contacts/known-logos.server.ts";

describe("company-logo cleanup uses the canonical sha set", () => {
  it("does not carry a private buildKnownCompanyLogoShaSet", async () => {
    const src = await read(CLEANUP);
    // A private copy is how this drifted: the local one was unbounded,
    // unordered, sequential and had no per-fetch timeout, while running on
    // every 10-id batch.
    expect(src).not.toMatch(/(async\s+)?function buildKnownCompanyLogoShaSet/);
  });

  it("imports the shared implementation instead", async () => {
    const src = await read(CLEANUP);
    expect(src).toContain("@/lib/contacts/known-logos.server");
    expect(src).toContain("buildKnownCompanyLogoShaSet(context.userId");
  });

  it("still ORs in the recorded hashes, which is what covers custom uploads", async () => {
    // fetchChosenCompanyLogoBytes only walks remote providers — it never reads
    // companies.logo_url — so company_logo_hashes is the ONLY channel by which
    // a custom-uploaded logo reaches a sha set. Capping the domain walk must
    // not be mistaken for dropping this.
    const src = await read(CLEANUP);
    expect(src).toContain("getKnownCompanyLogoHashes");
    expect(src).toContain("recordedShas");
  });
});

describe("known-logos sha set stays bounded", () => {
  it("caps the domains walked, and bounds concurrency and per-fetch time", async () => {
    const src = await read(KNOWN_LOGOS);
    expect(src).toMatch(/MAX_DOMAINS\s*=\s*\d+/);
    expect(src).toMatch(/CONCURRENCY\s*=\s*\d+/);
    expect(src).toMatch(/FETCH_TIMEOUT_MS\s*=\s*\d+/);
  });

  it("seeds from company_logo_hashes so custom uploads are recognized", async () => {
    expect(await read(KNOWN_LOGOS)).toContain("company_logo_hashes");
  });
});

describe("known-logo sha cache is invalidated when the logo bytes change", () => {
  // The cache is a 5-minute per-user TTL. Before this, nothing in production
  // ever invalidated it, so the pull guard ran on a stale set after a logo
  // change and could promote the new logo into a contact's avatar.
  const MUTATORS = [
    ["a custom logo upload", "src/lib/companies/company-photo.server.ts"],
    ["setting or clearing a brand pick", "src/lib/company-logo.functions.ts"],
  ] as const;

  for (const [what, file] of MUTATORS) {
    it(`invalidates after ${what}`, async () => {
      expect(await read(file)).toContain("invalidateKnownCompanyLogoShaCache");
    });
  }
});
