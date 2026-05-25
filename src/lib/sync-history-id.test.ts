// Gmail historyIds are unsigned 64-bit decimals stored as TEXT in the DB.
// gmailHistoryIdGreater is the JS-side monotonic guard that pairs with the
// SQL `bump_history_id_if_greater` RPC — both must agree on "is this id
// strictly higher than the current one?" or the cross-replica race is
// still open.
import { describe, it, expect } from "vitest";
import { gmailHistoryIdGreater } from "./sync.server";

describe("gmailHistoryIdGreater", () => {
  it("returns true when the current id is null (first push for an account)", () => {
    expect(gmailHistoryIdGreater("12345", null)).toBe(true);
    expect(gmailHistoryIdGreater("12345", "")).toBe(true);
  });

  it("returns false when the incoming id is null/empty", () => {
    expect(gmailHistoryIdGreater(null, "12345")).toBe(false);
    expect(gmailHistoryIdGreater("", "12345")).toBe(false);
  });

  it("uses numeric comparison even when text comparison would lie", () => {
    // The classic trap: text-sort "9" > "10" but numerically 9 < 10.
    expect(gmailHistoryIdGreater("10", "9")).toBe(true);
    expect(gmailHistoryIdGreater("9", "10")).toBe(false);
    // Same digit length, text comparison happens to agree numerically.
    expect(gmailHistoryIdGreater("100", "099")).toBe(true);
    // Different digit lengths in the typical Gmail range.
    expect(gmailHistoryIdGreater("1000000", "999999")).toBe(true);
    expect(gmailHistoryIdGreater("999999", "1000000")).toBe(false);
  });

  it("handles ids that exceed Number.MAX_SAFE_INTEGER via BigInt", () => {
    // 2^53 + 1 is the first integer Number can't represent precisely.
    expect(gmailHistoryIdGreater("9007199254740993", "9007199254740992")).toBe(true);
    expect(gmailHistoryIdGreater("9007199254740992", "9007199254740993")).toBe(false);
    // 64-bit boundary cases (close to uint64 max).
    expect(gmailHistoryIdGreater("18446744073709551614", "18446744073709551613")).toBe(true);
    expect(gmailHistoryIdGreater("18446744073709551613", "18446744073709551614")).toBe(false);
  });

  it("treats equal ids as NOT strictly greater", () => {
    expect(gmailHistoryIdGreater("12345", "12345")).toBe(false);
    expect(gmailHistoryIdGreater("0", "0")).toBe(false);
  });

  it("falls back to length-then-lex for non-decimal input", () => {
    // Both contain non-digits → fallback path.
    expect(gmailHistoryIdGreater("abc", "ab")).toBe(true);
    expect(gmailHistoryIdGreater("ab", "abc")).toBe(false);
    expect(gmailHistoryIdGreater("abz", "abc")).toBe(true);
  });

  it("handles a real-world Gmail history-id transition (15 → 16 digits)", () => {
    // When a Gmail account's history_id crosses a digit boundary, text-sort
    // would say "old > new". BigInt path catches this.
    expect(gmailHistoryIdGreater("100000000000000", "99999999999999")).toBe(true);
    expect(gmailHistoryIdGreater("99999999999999", "100000000000000")).toBe(false);
  });
});
