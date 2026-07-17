// Pure phone-normalization helper. Reused by Google-pull dedup and the
// duplicate scanner. We deliberately keep this dumb — full E.164 parsing is
// overkill for our matching needs. Two rules:
//   1) strip everything that isn't a digit
//   2) if the result is >= 10 digits, keep only the last 10 (this collapses
//      US country-code variants "+1 415 555 0000" ↔ "415-555-0000")
// Callers should treat an empty string as "no phone".

export function normalizePhone(input: string | null | undefined): string {
  if (!input) return "";
  const digits = String(input).replace(/\D+/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

export function normalizePhones(inputs: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const p of inputs) {
    const n = normalizePhone(p);
    if (n) out.add(n);
  }
  return Array.from(out);
}
