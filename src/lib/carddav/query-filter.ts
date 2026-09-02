// The `<C:filter>` element of an RFC 6352 `addressbook-query` REPORT.
//
// SCOPE. This implements the subset real clients send: `prop-filter` on FN,
// EMAIL, TEL and UID, each carrying one or more `text-match` elements, with
// the `test="anyof"|"allof"` grouping on both the filter and each prop-filter,
// the `match-type` attribute (contains / equals / starts-with / ends-with,
// defaulting to contains) and `negate-condition`.
//
// Anything outside that subset — `is-not-defined`, `param-filter`, another
// property name, a collation other than the case-insensitive default, an
// unknown match-type — parses to `unsupported`, and the caller answers with
// the whole collection rather than a wrong subset. A superset is something a
// client can narrow itself; a silently missing card is not.
//
// Parsing is regex-based like the rest of this directory's XML layer: the
// bodies are small, hand-written by a handful of clients, and nest exactly two
// levels deep.

export type MatchType = "contains" | "equals" | "starts-with" | "ends-with";

/** The vCard properties a filter may name here. */
export const FILTERABLE_PROPS = ["FN", "EMAIL", "TEL", "UID"] as const;
export type FilterableProp = (typeof FILTERABLE_PROPS)[number];

export type TextMatch = { value: string; matchType: MatchType; negate: boolean };
export type PropFilter = { prop: FilterableProp; test: "anyof" | "allof"; matches: TextMatch[] };
export type AddressbookFilter = { test: "anyof" | "allof"; props: PropFilter[] };

export type ParsedFilter =
  /** No `<C:filter>` in the body: the query covers the whole collection. */
  | { kind: "none" }
  /** A filter we cannot evaluate faithfully; the caller returns everything. */
  | { kind: "unsupported" }
  | { kind: "filter"; filter: AddressbookFilter };

/** The values a card actually carries for each filterable property. An empty
 * list means the property is not defined on that card, which per RFC 6352
 * §10.5.1 makes any text-match prop-filter on it false. */
export type CardFields = Record<FilterableProp, string[]>;

const FILTER_ELEMENT =
  /<(?:[A-Za-z_][\w.-]*:)?filter\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?filter\s*>)/i;
const PROP_FILTER_ELEMENT =
  /<(?:[A-Za-z_][\w.-]*:)?prop-filter\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?prop-filter\s*>)/gi;
const TEXT_MATCH_ELEMENT =
  /<(?:[A-Za-z_][\w.-]*:)?text-match\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?text-match\s*>)/gi;
/** Any element at all — used to prove nothing unhandled is left behind. */
const ANY_ELEMENT = /<[A-Za-z_/]/;

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m?.[1] ?? null;
}

function readTest(attrs: string): "anyof" | "allof" | null {
  const raw = attr(attrs, "test");
  if (raw === null) return "anyof"; // RFC 6352 default.
  const v = raw.trim().toLowerCase();
  return v === "anyof" || v === "allof" ? v : null;
}

/** Decode the handful of entities a client will have escaped a match value
 * with. The values are compared, never re-emitted, so this only has to undo
 * what `xmlEscape` would have produced. */
function xmlUnescape(v: string): string {
  return v
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseTextMatches(inner: string): TextMatch[] | null {
  const out: TextMatch[] = [];
  let rest = inner;
  for (const m of inner.matchAll(TEXT_MATCH_ELEMENT)) {
    rest = rest.replace(m[0]!, "");
    const attrs = m[1] ?? "";
    // The default collation is i;unicode-casemap (case-insensitive). Any
    // other collation would need real semantics we do not have.
    const collation = attr(attrs, "collation");
    if (collation !== null && collation.trim().toLowerCase() !== "i;unicode-casemap") return null;
    const rawType = (attr(attrs, "match-type") ?? "contains").trim().toLowerCase();
    if (
      rawType !== "contains" &&
      rawType !== "equals" &&
      rawType !== "starts-with" &&
      rawType !== "ends-with"
    ) {
      return null;
    }
    const negateRaw = (attr(attrs, "negate-condition") ?? "no").trim().toLowerCase();
    if (negateRaw !== "yes" && negateRaw !== "no") return null;
    out.push({
      value: xmlUnescape((m[2] ?? "").trim()),
      matchType: rawType,
      negate: negateRaw === "yes",
    });
  }
  // Anything left over (is-not-defined, param-filter, …) is unhandled.
  if (ANY_ELEMENT.test(rest)) return null;
  return out.length > 0 ? out : null;
}

/** Read the `<C:filter>` of an addressbook-query body. */
export function parseAddressbookFilter(body: string): ParsedFilter {
  const filterMatch = body.match(FILTER_ELEMENT);
  if (!filterMatch) return { kind: "none" };
  const test = readTest(filterMatch[1] ?? "");
  if (!test) return { kind: "unsupported" };
  const inner = filterMatch[2] ?? "";
  if (!inner.trim()) return { kind: "none" };

  const props: PropFilter[] = [];
  let rest = inner;
  for (const pf of inner.matchAll(PROP_FILTER_ELEMENT)) {
    rest = rest.replace(pf[0]!, "");
    const attrs = pf[1] ?? "";
    const name = (attr(attrs, "name") ?? "").trim().toUpperCase();
    const prop = FILTERABLE_PROPS.find((p) => p === name);
    if (!prop) return { kind: "unsupported" };
    const propTest = readTest(attrs);
    if (!propTest) return { kind: "unsupported" };
    const matches = parseTextMatches(pf[2] ?? "");
    if (!matches) return { kind: "unsupported" };
    props.push({ prop, test: propTest, matches });
  }
  if (ANY_ELEMENT.test(rest)) return { kind: "unsupported" };
  if (props.length === 0) return { kind: "none" };
  return { kind: "filter", filter: { test, props } };
}

function textMatches(value: string, m: TextMatch): boolean {
  // i;unicode-casemap: case-insensitive comparison.
  const hay = value.toLowerCase();
  const needle = m.value.toLowerCase();
  switch (m.matchType) {
    case "equals":
      return hay === needle;
    case "starts-with":
      return hay.startsWith(needle);
    case "ends-with":
      return hay.endsWith(needle);
    case "contains":
      return hay.includes(needle);
  }
}

function propFilterMatches(pf: PropFilter, fields: CardFields): boolean {
  const values = fields[pf.prop];
  // RFC 6352 §10.5.1: a prop-filter carrying a text-match is false when the
  // property is not defined on the card, negate-condition or not.
  if (values.length === 0) return false;
  const results = pf.matches.map((m) => {
    const hit = values.some((v) => textMatches(v, m));
    return m.negate ? !hit : hit;
  });
  return pf.test === "allof" ? results.every(Boolean) : results.some(Boolean);
}

/** Whether a card's property values satisfy the filter. */
export function cardMatchesFilter(filter: AddressbookFilter, fields: CardFields): boolean {
  const results = filter.props.map((pf) => propFilterMatches(pf, fields));
  return filter.test === "allof" ? results.every(Boolean) : results.some(Boolean);
}
