import { describe, expect, it } from "vitest";
import {
  clusterLabels,
  dominantCompany,
  sortCanonicalFirst,
  type LabelClusterInput,
} from "./label-clusters";

function label(
  id: string,
  name: string,
  overrides: Partial<LabelClusterInput> = {},
): LabelClusterInput {
  return {
    id,
    name,
    parent_group_id: "factory",
    auto_generated_from_group_id: "factory",
    member_count: 5,
    company_id: null,
    ...overrides,
  };
}

describe("clusterLabels", () => {
  it("clusters all labels sharing one company regardless of names", () => {
    // The production bug: four Nissan variants, one company row.
    const labels = [
      label("a", "Nissan", { company_id: "co1" }),
      label("b", "Nissan Motor Acceptance Company", { company_id: "co1" }),
      label("c", "Nissan North America", { company_id: "co1" }),
      label("d", "Nissan-usa.com", { company_id: "co1" }),
      label("e", "Toyota", { company_id: "co2" }),
    ];
    const clusters = clusterLabels(labels);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].labels.map((l) => l.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(clusters[0].reason).toBe("company");
  });

  it("folds a merged-away company name via aliases", () => {
    const labels = [label("a", "Kia"), label("b", "Kia America Inc")];
    const clusters = clusterLabels(labels, new Map([["kia america", "Kia"]]));
    expect(clusters).toHaveLength(1);
    expect(clusters[0].reason).toBe("alias");
  });

  it("clusters brand-name variants by aggressive normalization", () => {
    const labels = [
      label("a", "Nissan"),
      label("b", "Nissan North America"),
      label("c", "Nissan Of Keene"), // dealer — stays out
    ];
    const clusters = clusterLabels(labels);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].labels.map((l) => l.id).sort()).toEqual(["a", "b"]);
    expect(clusters[0].reason).toBe("name");
  });

  it("unions name-matched and company-matched labels into one cluster", () => {
    const labels = [
      label("a", "Nissan", { company_id: "co1" }),
      label("b", "Nissan North America"), // joins a by name
      label("c", "NMAC", { company_id: "co1" }), // joins a by company
    ];
    const clusters = clusterLabels(labels);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].labels.map((l) => l.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps parent scopes isolated", () => {
    const labels = [
      label("a", "Nissan", { parent_group_id: "factory" }),
      label("b", "Nissan", { parent_group_id: "dealers" }),
    ];
    expect(clusterLabels(labels)).toHaveLength(0);
  });

  it("does not company-cluster labels without a shared company", () => {
    const labels = [
      label("a", "Attorneys", { company_id: null }),
      label("b", "Banks", { company_id: null }),
    ];
    expect(clusterLabels(labels)).toHaveLength(0);
  });
});

describe("dominantCompany", () => {
  const companies = new Map<string, string | null>([
    ["c1", "nissan"],
    ["c2", "nissan"],
    ["c3", "nissan"],
    ["c4", "toyota"],
    ["c5", null],
  ]);

  it("returns the strict-majority company", () => {
    expect(dominantCompany(["c1", "c2", "c3", "c4"], companies)).toBe("nissan");
  });

  it("returns null without a strict majority", () => {
    // 2 nissan of 4 members (one toyota, one unlinked) is not > 50%.
    expect(dominantCompany(["c1", "c2", "c4", "c5"], companies)).toBeNull();
  });

  it("returns null for empty membership", () => {
    expect(dominantCompany([], companies)).toBeNull();
  });
});

describe("sortCanonicalFirst", () => {
  it("prefers most members, then non-auto, then shortest name", () => {
    const sorted = sortCanonicalFirst([
      label("a", "Nissan North America", { member_count: 7 }),
      label("b", "Nissan", { member_count: 7, auto_generated_from_group_id: null }),
      label("c", "Nissan-usa.com", { member_count: 3 }),
    ]);
    expect(sorted.map((l) => l.id)).toEqual(["b", "a", "c"]);
  });
});
