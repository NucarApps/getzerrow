import { describe, it, expect, vi } from "vitest";
import { buildLockedFieldSet, computeEnrichmentFieldPatch } from "./enrich-locks";

// Trivial stand-in for pickBetterName — always prefers the candidate when
// truthy, so any change would be visible in the resulting patch. The real
// helper is exercised in its own module; here we only care that lock
// gating prevents changes to name in the first place.
const pickBetterName = (
  a: string | null | undefined,
  b: string | null | undefined,
): string | null => (b && b.trim() ? b : (a ?? null));

describe("buildLockedFieldSet", () => {
  it("returns an empty set for a fresh contact", () => {
    const locked = buildLockedFieldSet({});
    expect(locked.size).toBe(0);
  });

  it("locks every field named in manual_overrides", () => {
    const locked = buildLockedFieldSet({
      manual_overrides: ["name", "company", "phone"],
    });
    expect(locked.has("name")).toBe(true);
    expect(locked.has("company")).toBe(true);
    expect(locked.has("phone")).toBe(true);
    expect(locked.has("title")).toBe(false);
  });

  it("implicitly locks company when company_id is set", () => {
    const locked = buildLockedFieldSet({ company_id: "co_123" });
    expect(locked.has("company")).toBe(true);
  });

  it("keeps name locked when manual_overrides has it even without company_id", () => {
    const locked = buildLockedFieldSet({ manual_overrides: ["name"] });
    expect(locked.has("name")).toBe(true);
    expect(locked.has("company")).toBe(false);
  });
});

describe("computeEnrichmentFieldPatch — manual edits are never overwritten", () => {
  it("never rewrites name when name is in manual_overrides", () => {
    const patch = computeEnrichmentFieldPatch({
      contact: {
        name: "Aditya",
        company: "Nissan",
        manual_overrides: ["name"],
      },
      extracted: { name: "Adi Kumar", company: "Nissan" },
      fromNameCandidate: "Adi K.",
      force: true,
      pickBetterName,
    });
    expect(patch.name).toBeUndefined();
  });

  it("never rewrites company when company is in manual_overrides", () => {
    const patch = computeEnrichmentFieldPatch({
      contact: {
        name: "Aditya",
        company: "Fenway Sports Group",
        manual_overrides: ["company"],
      },
      extracted: { company: "Nissan" },
      fromNameCandidate: null,
      force: true,
      pickBetterName,
    });
    expect(patch.company).toBeUndefined();
  });

  it("never rewrites company when contact is linked via company_id, even without an explicit override", () => {
    const patch = computeEnrichmentFieldPatch({
      contact: {
        name: "Erica",
        company: "Fenway Sports Group",
        company_id: "co_fsg",
      },
      extracted: { company: "Nissan" },
      fromNameCandidate: null,
      force: true,
      pickBetterName,
    });
    expect(patch.company).toBeUndefined();
  });

  it("respects locks even when force=true (locks always win)", () => {
    const patch = computeEnrichmentFieldPatch({
      contact: {
        name: "Aditya",
        company: "Nissan",
        title: "Manager",
        manual_overrides: ["name", "company", "title"],
      },
      extracted: {
        name: "Someone Else",
        company: "Different Co",
        title: "New Title",
      },
      fromNameCandidate: "Someone Else",
      force: true,
      pickBetterName,
    });
    expect(patch.name).toBeUndefined();
    expect(patch.company).toBeUndefined();
    expect(patch.title).toBeUndefined();
  });

  it("locking one field does not accidentally lock the others", () => {
    const patch = computeEnrichmentFieldPatch({
      contact: {
        name: "Aditya",
        title: null,
        company: "Nissan",
        manual_overrides: ["company"],
      },
      extracted: { title: "Engineer", company: "New Co" },
      fromNameCandidate: null,
      force: false,
      pickBetterName,
    });
    expect(patch.company).toBeUndefined();
    expect(patch.title).toBe("Engineer");
  });

  it("still fills empty fields that are not locked", () => {
    const patch = computeEnrichmentFieldPatch({
      contact: {
        name: "Aditya",
        company: "Nissan",
        title: null,
        manual_overrides: ["name", "company"],
      },
      extracted: { name: "Adi K.", company: "Other", title: "PM" },
      fromNameCandidate: null,
      force: false,
      pickBetterName,
    });
    expect(patch.name).toBeUndefined();
    expect(patch.company).toBeUndefined();
    expect(patch.title).toBe("PM");
  });

  it("does not call pickBetterName when name is locked (defence-in-depth)", () => {
    const spy = vi.fn(pickBetterName);
    computeEnrichmentFieldPatch({
      contact: { name: "Aditya", manual_overrides: ["name"] },
      extracted: { name: "Someone Else" },
      fromNameCandidate: "Someone Else",
      force: true,
      pickBetterName: spy,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("without a lock, force=true DOES overwrite an existing value (control case)", () => {
    const patch = computeEnrichmentFieldPatch({
      contact: { name: "Aditya", company: "Nissan" },
      extracted: { company: "Fenway Sports Group" },
      fromNameCandidate: null,
      force: true,
      pickBetterName,
    });
    // Proves the tests above pass because of the LOCK, not because the
    // merge logic never overwrites anything.
    expect(patch.company).toBe("Fenway Sports Group");
  });

  it("without a lock, force=false leaves an existing value alone", () => {
    const patch = computeEnrichmentFieldPatch({
      contact: { name: "Aditya", company: "Nissan" },
      extracted: { company: "Fenway Sports Group" },
      fromNameCandidate: null,
      force: false,
      pickBetterName,
    });
    expect(patch.company).toBeUndefined();
  });
});
