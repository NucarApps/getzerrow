// The addressbook-query `<C:filter>` reader. The handler suite proves the
// filter reaches the right cards; this one pins the grammar itself — which
// constructs parse, which are refused as unsupported (so the handler answers
// with the whole collection), and the RFC 6352 §10.5 matching rules.
import { describe, expect, it } from "vitest";
import {
  cardMatchesFilter,
  parseAddressbookFilter,
  type AddressbookFilter,
  type CardFields,
} from "./query-filter";

function filterFrom(xml: string): AddressbookFilter {
  const parsed = parseAddressbookFilter(
    '<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">' +
      xml +
      "</C:addressbook-query>",
  );
  if (parsed.kind !== "filter") throw new Error(`expected a filter, got ${parsed.kind}`);
  return parsed.filter;
}

function kindOf(xml: string): string {
  return parseAddressbookFilter(
    '<C:addressbook-query xmlns:C="urn:ietf:params:xml:ns:carddav">' +
      xml +
      "</C:addressbook-query>",
  ).kind;
}

const CARD: CardFields = {
  FN: ["Erica Roy"],
  EMAIL: ["erica@acme.example", "erica@home.example"],
  TEL: ["+1 555 0101"],
  UID: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
};

describe("parseAddressbookFilter", () => {
  it("reads a prop-filter with its match-type, negate flag and defaults", () => {
    expect(
      filterFrom(
        '<C:filter><C:prop-filter name="FN">' +
          '<C:text-match match-type="starts-with" negate-condition="yes">Er</C:text-match>' +
          "</C:prop-filter></C:filter>",
      ),
    ).toStrictEqual({
      test: "anyof",
      props: [
        {
          prop: "FN",
          test: "anyof",
          matches: [{ value: "Er", matchType: "starts-with", negate: true }],
        },
      ],
    });
  });

  it("defaults both test attributes to anyof and match-type to contains", () => {
    const f = filterFrom(
      '<C:filter><C:prop-filter name="EMAIL"><C:text-match>acme</C:text-match></C:prop-filter></C:filter>',
    );
    expect(f.test).toBe("anyof");
    expect(f.props[0]!.test).toBe("anyof");
    expect(f.props[0]!.matches[0]!.matchType).toBe("contains");
  });

  it("carries an explicit allof on the filter and on a prop-filter", () => {
    const f = filterFrom(
      '<C:filter test="allof"><C:prop-filter name="FN" test="allof">' +
        "<C:text-match>a</C:text-match><C:text-match>b</C:text-match>" +
        "</C:prop-filter></C:filter>",
    );
    expect(f.test).toBe("allof");
    expect(f.props[0]!.test).toBe("allof");
    expect(f.props[0]!.matches).toHaveLength(2);
  });

  it("reads the property name case-insensitively and past any prefix", () => {
    expect(
      filterFrom(
        '<X:filter><X:prop-filter name="email"><X:text-match>a</X:text-match></X:prop-filter></X:filter>',
      ).props[0]!.prop,
    ).toBe("EMAIL");
  });

  it("unescapes entities in the match value", () => {
    expect(
      filterFrom(
        '<C:filter><C:prop-filter name="FN"><C:text-match>Ben &amp; Jerry</C:text-match></C:prop-filter></C:filter>',
      ).props[0]!.matches[0]!.value,
    ).toBe("Ben & Jerry");
  });

  it("reports no filter for a body without one, and for an empty filter element", () => {
    expect(kindOf("")).toBe("none");
    expect(kindOf("<C:filter/>")).toBe("none");
    expect(kindOf("<C:filter></C:filter>")).toBe("none");
  });

  it("refuses everything outside the implemented subset", () => {
    const unsupported = [
      // A property this server does not index.
      '<C:filter><C:prop-filter name="NICKNAME"><C:text-match>x</C:text-match></C:prop-filter></C:filter>',
      // Constructs with semantics we do not implement.
      '<C:filter><C:prop-filter name="EMAIL"><C:is-not-defined/></C:prop-filter></C:filter>',
      '<C:filter><C:prop-filter name="TEL"><C:param-filter name="TYPE">' +
        "<C:text-match>WORK</C:text-match></C:param-filter></C:prop-filter></C:filter>",
      // A prop-filter with no text-match at all matches by existence, which
      // is not the same question as any text-match answers.
      '<C:filter><C:prop-filter name="FN"/></C:filter>',
      // Attribute values we cannot honour.
      '<C:filter test="someof"><C:prop-filter name="FN"><C:text-match>x</C:text-match></C:prop-filter></C:filter>',
      '<C:filter><C:prop-filter name="FN" test="oneof"><C:text-match>x</C:text-match></C:prop-filter></C:filter>',
      '<C:filter><C:prop-filter name="FN"><C:text-match match-type="regex">x</C:text-match></C:prop-filter></C:filter>',
      '<C:filter><C:prop-filter name="FN"><C:text-match collation="i;octet">x</C:text-match></C:prop-filter></C:filter>',
    ];
    for (const xml of unsupported) expect(kindOf(xml), xml).toBe("unsupported");
  });

  it("accepts the default collation spelled out", () => {
    expect(
      kindOf(
        '<C:filter><C:prop-filter name="FN">' +
          '<C:text-match collation="i;unicode-casemap">x</C:text-match>' +
          "</C:prop-filter></C:filter>",
      ),
    ).toBe("filter");
  });
});

describe("cardMatchesFilter", () => {
  const one = (xml: string) => cardMatchesFilter(filterFrom(xml), CARD);

  it("applies each match-type case-insensitively", () => {
    const fn = (type: string, value: string) =>
      one(
        `<C:filter><C:prop-filter name="FN"><C:text-match match-type="${type}">${value}</C:text-match></C:prop-filter></C:filter>`,
      );
    expect(fn("equals", "erica roy")).toBe(true);
    expect(fn("equals", "Erica")).toBe(false);
    expect(fn("starts-with", "ERI")).toBe(true);
    expect(fn("ends-with", "roy")).toBe(true);
    expect(fn("contains", "ca R")).toBe(true);
    expect(fn("contains", "zzz")).toBe(false);
  });

  it("matches when ANY value of a multi-valued property matches", () => {
    expect(
      one(
        '<C:filter><C:prop-filter name="EMAIL"><C:text-match>home</C:text-match></C:prop-filter></C:filter>',
      ),
    ).toBe(true);
  });

  it("negate-condition inverts the whole property test, not each value", () => {
    // "home" matches the second address, so the negated filter is false even
    // though the first address does not contain it.
    expect(
      one(
        '<C:filter><C:prop-filter name="EMAIL">' +
          '<C:text-match negate-condition="yes">home</C:text-match>' +
          "</C:prop-filter></C:filter>",
      ),
    ).toBe(false);
    expect(
      one(
        '<C:filter><C:prop-filter name="EMAIL">' +
          '<C:text-match negate-condition="yes">nowhere</C:text-match>' +
          "</C:prop-filter></C:filter>",
      ),
    ).toBe(true);
  });

  it("is false for a property the card does not define, negated or not", () => {
    // RFC 6352 §10.5.1: a text-match prop-filter needs the property to exist.
    // is-not-defined is the element that asks the other question, and it is
    // refused at parse time rather than answered wrongly here.
    const empty: CardFields = { FN: ["Group"], EMAIL: [], TEL: [], UID: ["g"] };
    const negated = filterFrom(
      '<C:filter><C:prop-filter name="TEL">' +
        '<C:text-match negate-condition="yes">555</C:text-match>' +
        "</C:prop-filter></C:filter>",
    );
    expect(cardMatchesFilter(negated, empty)).toBe(false);
  });

  it("combines prop-filters with anyof / allof", () => {
    const two = (test: string) =>
      one(
        `<C:filter test="${test}">` +
          '<C:prop-filter name="FN"><C:text-match>Erica</C:text-match></C:prop-filter>' +
          '<C:prop-filter name="TEL"><C:text-match>9999</C:text-match></C:prop-filter>' +
          "</C:filter>",
      );
    expect(two("anyof")).toBe(true);
    expect(two("allof")).toBe(false);
  });

  it("combines the text-matches inside one prop-filter with its own test", () => {
    const two = (test: string) =>
      one(
        `<C:filter><C:prop-filter name="FN" test="${test}">` +
          "<C:text-match>Erica</C:text-match><C:text-match>Nobody</C:text-match>" +
          "</C:prop-filter></C:filter>",
      );
    expect(two("anyof")).toBe(true);
    expect(two("allof")).toBe(false);
  });
});
