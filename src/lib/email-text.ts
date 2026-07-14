const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const withInbox = (labels: string[] | null | undefined): string[] =>
  Array.from(new Set([...(labels ?? []), "INBOX"]));

export const withoutInbox = (labels: string[] | null | undefined): string[] =>
  (labels ?? []).filter((l) => l !== "INBOX");

export function parseSearchQuery(input: string): {
  from: string | null;
  to: string | null;
  rest: string;
} {
  let from: string | null = null;
  let to: string | null = null;
  // Match from:value or to:value where value is either "quoted string" or non-whitespace.
  const re = /\b(from|to):\s*(?:"([^"]+)"|(\S+))/gi;
  const rest = input
    .replace(re, (_m, key: string, quoted?: string, bare?: string) => {
      const value = (quoted ?? bare ?? "").trim();
      if (!value) return "";
      if (key.toLowerCase() === "from") from = value;
      else to = value;
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { from, to, rest };
}
