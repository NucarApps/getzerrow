// deriveLabelKey is THE shared key for label identity. Every label-create
// path (manual create, auto company subgroups, Google group import, CardDAV
// CATEGORIES, suggestion apply, company linking) must derive the same key
// for the same real-world company so "Nissan" never duplicates again.

import { describe, it, expect } from "vitest";
import { deriveLabelKey, pickExistingLabel } from "./label-resolve";

describe("deriveLabelKey", () => {
  it("collapses case, whitespace, punctuation and legal suffixes onto one key", () => {
    const variants = ["Nissan", " nissan ", "NISSAN", "Nissan, Inc.", "Nissan North America"];
    const keys = variants.map((v) => deriveLabelKey(v).key);
    for (const k of keys) expect(k).toBe("nissan");
  });

  it("folds merged-away company variants via the alias map", () => {
    const aliases = new Map([["nissan motor acceptance company", "Nissan"]]);
    const res = deriveLabelKey("Nissan Motor Acceptance Company", aliases);
    expect(res.key).toBe("nissan");
    expect(res.viaAlias).toBe(true);
  });

  it("without the alias, distinct entities keep distinct keys", () => {
    expect(deriveLabelKey("Nissan Motor Acceptance Company").key).not.toBe("nissan");
  });

  it("leaves non-company labels alone", () => {
    expect(deriveLabelKey("Friends").key).toBe("friends");
    expect(deriveLabelKey("Family").key).toBe("family");
    expect(deriveLabelKey("Friends").key).not.toBe(deriveLabelKey("Family").key);
  });

  it("returns null for empty names", () => {
    expect(deriveLabelKey("").key).toBeNull();
    expect(deriveLabelKey("   ").key).toBeNull();
    // Degenerate punctuation names fall back to the mild key so they only
    // ever dedupe against themselves — never against real company labels.
    expect(deriveLabelKey("-").key).toBe("-");
    expect(deriveLabelKey("-").key).not.toBe(deriveLabelKey("nissan").key);
  });
});

describe("pickExistingLabel", () => {
  const label = (id: string, name: string, parent: string | null = null, members = 0) => ({
    id,
    name,
    parent_group_id: parent,
    member_count: members,
  });

  it("matches name variants within the same parent scope", () => {
    const labels = [label("a", "Nissan"), label("b", "Toyota")];
    expect(pickExistingLabel("Nissan, Inc.", null, labels)?.id).toBe("a");
  });

  it("keeps the same name under different parents distinct", () => {
    const labels = [label("a", "Nissan", "parent-1")];
    expect(pickExistingLabel("Nissan", null, labels)).toBeNull();
    expect(pickExistingLabel("Nissan", "parent-2", labels)).toBeNull();
    expect(pickExistingLabel("Nissan", "parent-1", labels)?.id).toBe("a");
  });

  it("prefers the exact (case-insensitive) name match over other key matches", () => {
    const labels = [label("a", "Nissan North America", null, 50), label("b", "Nissan", null, 2)];
    expect(pickExistingLabel("nissan", null, labels)?.id).toBe("b");
  });

  it("otherwise prefers the label with the most members", () => {
    const labels = [label("a", "Nissan, Inc.", null, 2), label("b", "Nissan USA", null, 9)];
    expect(pickExistingLabel("Nissan", null, labels)?.id).toBe("b");
  });

  it("resolves through aliases too", () => {
    const aliases = new Map([["nissan motor acceptance company", "Nissan"]]);
    const labels = [label("a", "Nissan")];
    expect(pickExistingLabel("Nissan Motor Acceptance Company", null, labels, aliases)?.id).toBe(
      "a",
    );
  });

  it("returns null when the name has no derivable key", () => {
    expect(pickExistingLabel("  ", null, [label("a", "Nissan")])).toBeNull();
  });
});
