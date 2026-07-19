// Lightweight name matching helpers for enrichment / dedup.
// Deterministic (no AI) — used to score contact-to-email-participant matches.

/** Fold unicode, drop punctuation, collapse whitespace, lower-case. */
export function normalizeNameLoose(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Return [first, last] tokens from a name (drops middle names / initials). */
export function firstLastTokens(input: string | null | undefined): [string, string] | null {
  const n = normalizeNameLoose(input);
  if (!n) return null;
  // Handle "Last, First" from Gmail
  if (n.includes(",")) {
    const [last, first] = n.split(",").map((s) => s.trim());
    if (first && last) return [first.split(" ")[0], last.split(" ").pop() ?? last];
  }
  const parts = n.split(" ").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return [parts[0], ""];
  return [parts[0], parts[parts.length - 1]];
}

/** Damerau-ish Levenshtein distance (iterative, O(n*m)). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length;
  const n = b.length;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

export type NameMatchConfidence = "high" | "medium" | "low" | null;

/**
 * Compare a target name against a candidate name found in mail.
 * strictness 1 (loose) .. 5 (strict — exact only).
 */
export function nameMatchConfidence(
  target: string | null | undefined,
  candidate: string | null | undefined,
  strictness = 3,
): NameMatchConfidence {
  const t = firstLastTokens(target);
  const c = firstLastTokens(candidate);
  if (!t || !c) return null;
  const [tf, tl] = t;
  const [cf, cl] = c;

  // Exact first+last (case/punct-insensitive)
  if (tf && cf && tl && cl && tf === cf && tl === cl) return "high";

  if (strictness >= 5) return null;

  // Same last name + first-name initial or fuzzy first (dist <= 2)
  if (tl && cl && tl === cl) {
    if (!tf || !cf) return "medium";
    if (tf[0] === cf[0] && (tf.startsWith(cf) || cf.startsWith(tf))) return "medium";
    if (levenshtein(tf, cf) <= 2) return "medium";
  }

  if (strictness >= 4) return null;

  // Fuzzy full name distance
  const tFull = `${tf} ${tl}`.trim();
  const cFull = `${cf} ${cl}`.trim();
  if (tFull && cFull) {
    const d = levenshtein(tFull, cFull);
    const maxLen = Math.max(tFull.length, cFull.length);
    if (maxLen > 0 && d / maxLen <= 0.2) return "low";
  }

  if (strictness >= 3) return null;

  // Loose: matching single token
  if (tf && cf && tf === cf) return "low";
  if (tl && cl && tl === cl) return "low";
  return null;
}

/** local-part of an email address (before @), lowercased; null if invalid. */
export function emailLocalPart(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return null;
  return email.slice(0, at).toLowerCase();
}
