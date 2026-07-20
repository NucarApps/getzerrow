import { describe, expect, it } from "vitest";
import { buildInlineCompanyMergeSuggestions, type InlineMergeBucket } from "./inline-merge";

describe("buildInlineCompanyMergeSuggestions", () => {
  it("routes linked company buckets through a real company merge", () => {
    const buckets: InlineMergeBucket[] = [
      {
        key: "cid:target",
        domain: "hermes.com",
        name: "Hermes Boston",
        kind: "company",
        companyId: "target",
        contacts: [{ id: "pam", company: "Hermes" }],
      },
      {
        key: "cid:source",
        domain: "hermes.com",
        name: "Palm Beach Hermes",
        kind: "company",
        companyId: "source",
        contacts: [{ id: "jackie", company: "Hermes" }],
      },
    ];

    const suggestion = buildInlineCompanyMergeSuggestions(buckets).get("cid:target");

    expect(suggestion).toMatchObject({
      kind: "company",
      primaryCompanyId: "target",
      sourceCompanyIds: ["source"],
      aliasContactIds: ["jackie"],
      otherCount: 1,
    });
  });

  it("keeps rename-only suggestions for buckets without company records", () => {
    const buckets: InlineMergeBucket[] = [
      {
        key: "hermes.com",
        domain: "hermes.com",
        name: "Hermes",
        kind: "company",
        contacts: [{ id: "pam", company: "Hermes" }],
      },
      {
        key: "name:hermes",
        domain: "hermes.com",
        name: "Hermes",
        kind: "company",
        contacts: [{ id: "jackie", company: "Hermes" }],
      },
    ];

    const suggestion = buildInlineCompanyMergeSuggestions(buckets).get("hermes.com");

    expect(suggestion).toMatchObject({
      kind: "rename",
      primaryCompanyId: null,
      sourceCompanyIds: [],
      aliasContactIds: ["jackie"],
    });
  });
});
