// Characterization tests for escapeLike — the helper that neutralizes SQL
// LIKE/ILIKE pattern metacharacters (%, _, \) before a value is interpolated
// into a PostgREST ilike() pattern. Without this, a value like "foo_bar.com"
// would also match "fooXbar.com" because `_` matches any single character.

import { describe, it, expect } from "vitest";
import { escapeLike } from "./escape-like";

describe("escapeLike", () => {
  it("escapes a lone %", () => {
    expect(escapeLike("100%")).toBe("100\\%");
  });

  it("escapes a lone _", () => {
    expect(escapeLike("foo_bar")).toBe("foo\\_bar");
  });

  it("escapes a lone backslash", () => {
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  it("returns the empty string unchanged", () => {
    expect(escapeLike("")).toBe("");
  });

  it("escapes a combined hostile pattern %_\\% left-to-right without re-escaping its own output", () => {
    // Each metacharacter is matched once by the character class and prefixed
    // with a single backslash; the regex does not re-scan its replacement,
    // so the inserted escape backslashes are not themselves re-escaped.
    expect(escapeLike("%_\\%")).toBe("\\%\\_\\\\\\%");
  });

  it("leaves ordinary text and other regex-special characters untouched", () => {
    expect(escapeLike("foo.bar+baz[1]")).toBe("foo.bar+baz[1]");
  });
});
