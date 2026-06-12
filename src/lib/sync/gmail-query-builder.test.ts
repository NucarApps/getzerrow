import { describe, it, expect } from "vitest";
import { buildGmailQueries, expandTreeToBranches } from "./gmail-query-builder";
import type { RuleNode } from "./types";

describe("expandTreeToBranches", () => {
  it("AND group → one combined branch", () => {
    const tree: RuleNode = {
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "domain", op: "contains", value: "docusign" },
        { type: "cond", field: "subject", op: "starts_with", value: "Completed" },
      ],
    };
    expect(expandTreeToBranches(tree)).toEqual([["from:docusign", "subject:Completed"]]);
  });

  it("OR group → separate branches", () => {
    const tree: RuleNode = {
      type: "group",
      op: "or",
      children: [
        { type: "cond", field: "subject", op: "contains", value: "invoice" },
        { type: "cond", field: "subject", op: "contains", value: "receipt" },
      ],
    };
    expect(expandTreeToBranches(tree)).toEqual([["subject:invoice"], ["subject:receipt"]]);
  });

  it("AND of (cond, OR group) → fans out into Cartesian product", () => {
    const tree: RuleNode = {
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "domain", op: "contains", value: "docusign" },
        {
          type: "group",
          op: "or",
          children: [
            { type: "cond", field: "subject", op: "starts_with", value: "Completed" },
            { type: "cond", field: "subject", op: "starts_with", value: "Signed" },
          ],
        },
      ],
    };
    expect(expandTreeToBranches(tree)).toEqual([
      ["from:docusign", "subject:Completed"],
      ["from:docusign", "subject:Signed"],
    ]);
  });

  it("skips negative and regex leaves silently", () => {
    const tree: RuleNode = {
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "domain", op: "contains", value: "docusign" },
        { type: "cond", field: "subject", op: "not_contains", value: "reminder" },
        { type: "cond", field: "body", op: "regex", value: "^x" },
      ],
    };
    expect(expandTreeToBranches(tree)).toEqual([["from:docusign"]]);
  });
});

describe("buildGmailQueries", () => {
  it("AND tree → single combined query with suffix", () => {
    const tree: RuleNode = {
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "domain", op: "contains", value: "docusign" },
        { type: "cond", field: "subject", op: "starts_with", value: "Completed" },
      ],
    };
    const r = buildGmailQueries({ filter_tree: tree, filters: [] }, { suffix: " newer_than:6m" });
    expect(r.queries).toEqual(["from:docusign subject:Completed newer_than:6m"]);
    expect(r.skippedRegex).toBe(0);
  });

  it("OR tree → multiple queries", () => {
    const tree: RuleNode = {
      type: "group",
      op: "or",
      children: [
        { type: "cond", field: "subject", op: "contains", value: "invoice" },
        { type: "cond", field: "subject", op: "contains", value: "receipt" },
      ],
    };
    const r = buildGmailQueries({ filter_tree: tree, filters: [] }, { suffix: " newer_than:6m" });
    expect(r.queries).toEqual(["subject:invoice newer_than:6m", "subject:receipt newer_than:6m"]);
  });

  it("tree present → flat filters ignored", () => {
    const tree: RuleNode = {
      type: "group",
      op: "and",
      children: [{ type: "cond", field: "domain", op: "contains", value: "docusign" }],
    };
    const r = buildGmailQueries({
      filter_tree: tree,
      filters: [{ field: "subject", op: "contains", value: "ignored" }],
    });
    expect(r.queries).toEqual(["from:docusign"]);
  });

  it("no tree → flat filters become independent queries", () => {
    const r = buildGmailQueries({
      filter_tree: null,
      filters: [
        { field: "domain", op: "contains", value: "docusign" },
        { field: "subject", op: "contains", value: "invoice" },
        { field: "subject", op: "not_contains", value: "ignored" },
      ],
    });
    expect(r.queries).toEqual(["from:docusign", "subject:invoice"]);
  });

  it("counts regex leaves in skippedRegex", () => {
    const tree: RuleNode = {
      type: "group",
      op: "or",
      children: [
        { type: "cond", field: "subject", op: "regex", value: "^x" },
        { type: "cond", field: "subject", op: "contains", value: "ok" },
      ],
    };
    const r = buildGmailQueries({ filter_tree: tree, filters: [] });
    expect(r.skippedRegex).toBe(1);
    expect(r.queries).toEqual(["subject:ok"]);
  });

  it("quotes values containing spaces or colons", () => {
    const r = buildGmailQueries({
      filter_tree: null,
      filters: [{ field: "subject", op: "contains", value: "hello world" }],
    });
    expect(r.queries).toEqual([`subject:"hello world"`]);
  });

  it("deduplicates identical queries", () => {
    const tree: RuleNode = {
      type: "group",
      op: "or",
      children: [
        { type: "cond", field: "subject", op: "contains", value: "dup" },
        { type: "cond", field: "subject", op: "contains", value: "dup" },
      ],
    };
    const r = buildGmailQueries({ filter_tree: tree, filters: [] });
    expect(r.queries).toEqual(["subject:dup"]);
  });
});
