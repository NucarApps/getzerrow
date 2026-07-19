// Merge of ranked, server-decrypted search hits with their list-view
// metadata rows. Runs server-side in searchInbox so the browser gets one
// round-trip; these tests pin rank order, missing-row handling, and that
// the decrypted fields always win over whatever the metadata row carries.

import { describe, it, expect } from "vitest";
import { mergeSearchRows } from "./search-merge";

const hit = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  subject: `decrypted subject ${id}`,
  snippet: `decrypted snippet ${id}`,
  from_name: `Sender ${id}`,
  rank: 1,
  ...over,
});

const meta = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  from_addr: `${id}@example.com`,
  received_at: "2026-07-01T00:00:00Z",
  is_read: false,
  is_archived: false,
  folder_id: null,
  subject: null, // encrypted column projected as null in metadata selects
  ...over,
});

describe("mergeSearchRows", () => {
  it("preserves the hits' rank order regardless of metadata order", () => {
    const merged = mergeSearchRows(
      [hit("a"), hit("b"), hit("c")],
      [meta("c"), meta("a"), meta("b")],
    );
    expect(merged.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("drops hits whose metadata row is missing (deleted between RPC and select)", () => {
    const merged = mergeSearchRows([hit("a"), hit("gone"), hit("b")], [meta("a"), meta("b")]);
    expect(merged.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("overlays the decrypted subject/snippet/from_name onto the metadata row", () => {
    const merged = mergeSearchRows([hit("a")], [meta("a")]);
    expect(merged[0]).toMatchObject({
      id: "a",
      from_addr: "a@example.com",
      subject: "decrypted subject a",
      snippet: "decrypted snippet a",
      from_name: "Sender a",
    });
  });

  it("returns empty for no hits without touching metadata", () => {
    expect(mergeSearchRows([], [meta("a")])).toEqual([]);
  });
});
