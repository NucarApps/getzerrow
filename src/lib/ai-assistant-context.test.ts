// Unit tests for the pure context shapers the inbox assistant feeds to the
// model (src/lib/ai-assistant-context.ts).

import { describe, it, expect } from "vitest";
import { aggregateDomainClusters, matchFolderByName } from "./ai-assistant-context";

const CLIENTS = "11111111-1111-4111-8111-111111111111";
const INVOICES = "22222222-2222-4222-8222-222222222222";

function rows(spec: Array<[from: string | null, folder: string | null]>) {
  return spec.map(([from_addr, folder_id]) => ({ from_addr, folder_id }));
}

describe("aggregateDomainClusters", () => {
  const names = new Map([[CLIENTS, "Clients"]]);

  it("groups by sender domain, busiest first, with per-folder counts", () => {
    const out = aggregateDomainClusters(
      rows([
        ["a@acme.com", CLIENTS],
        ["b@acme.com", null],
        ["c@acme.com", CLIENTS],
        ["d@other.com", null],
        ["e@other.com", null],
      ]),
      names,
    );

    expect(out).toStrictEqual([
      {
        domain: "acme.com",
        count: 3,
        folders: [
          { name: "Clients", count: 2 },
          { name: "Inbox", count: 1 },
        ],
      },
      { domain: "other.com", count: 2, folders: [{ name: "Inbox", count: 2 }] },
    ]);
  });

  it("drops domains below the minimum count", () => {
    const out = aggregateDomainClusters(rows([["a@acme.com", null]]), names);

    expect(out).toStrictEqual([]);
    expect(
      aggregateDomainClusters(rows([["a@acme.com", null]]), names, { minCount: 1 }),
    ).toHaveLength(1);
  });

  it("labels mail in an unknown folder as Inbox rather than dropping it", () => {
    const out = aggregateDomainClusters(
      rows([
        ["a@acme.com", INVOICES],
        ["b@acme.com", INVOICES],
      ]),
      names,
      { minCount: 1 },
    );

    expect(out[0]?.folders).toStrictEqual([{ name: "Inbox", count: 2 }]);
  });

  it("ignores rows with no parseable sender domain", () => {
    expect(
      aggregateDomainClusters(
        rows([
          [null, null],
          ["not-an-address", null],
        ]),
        names,
        { minCount: 1 },
      ),
    ).toStrictEqual([]);
  });

  it("returns at most topN clusters", () => {
    const many = Array.from({ length: 20 }, (_, i): [string, null] => [
      `a@d${i}.com`,
      null,
    ]).flatMap((r) => [r, r]);

    expect(aggregateDomainClusters(rows(many), names)).toHaveLength(15);
    expect(aggregateDomainClusters(rows(many), names, { topN: 3 })).toHaveLength(3);
  });
});

describe("matchFolderByName", () => {
  const folders = [
    { id: CLIENTS, name: "Clients" },
    { id: INVOICES, name: "Client Invoices" },
  ];

  it("prefers the longest folder name that appears in the message", () => {
    expect(matchFolderByName("why is acme mail not in Client Invoices?", folders)).toBe(INVOICES);
    expect(matchFolderByName("why is acme mail not in clients?", folders)).toBe(CLIENTS);
  });

  it("matches case-insensitively and ignores surrounding text", () => {
    expect(matchFolderByName("PLEASE FIX CLIENTS NOW", folders)).toBe(CLIENTS);
  });

  it("returns null when nothing matches", () => {
    expect(matchFolderByName("sort my mail", folders)).toBeNull();
    expect(matchFolderByName("anything", [])).toBeNull();
  });

  it("skips folder names too short to match reliably", () => {
    expect(matchFolderByName("put it in ab please", [{ id: CLIENTS, name: "ab" }])).toBeNull();
  });
});
