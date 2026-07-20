// Shared server-only helpers and constants used by src/lib/contacts/*.functions.ts.
// Anything referenced from more than one split file — or from a createServerFn
// handler / inputValidator — belongs here so the `?tss-serverfn-split`
// transform never has to reach across sibling module scope for it.
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway";
import { listMessages, getMessage, parseMessage } from "./gmail.server";

/** Fetch recent Gmail messages matching a query, for a user's connected accounts.
 * Returns parsed messages mapped into the same shape as our local emails_decrypted rows.
 * Swallows per-account errors (expired tokens, quota, insufficient scopes) and moves on. */
export async function fetchFromGmail(
  accountIds: string[],
  query: string,
  maxResults: number,
): Promise<Array<ReturnType<typeof parseMessage>>> {
  for (const accountId of accountIds) {
    try {
      const list = await listMessages(accountId, { q: query, maxResults });
      const ids = (list.messages ?? []).map((m) => m.id);
      if (ids.length === 0) continue;
      const out: Array<ReturnType<typeof parseMessage>> = [];
      for (const id of ids) {
        try {
          const msg = await getMessage(accountId, id);
          out.push(parseMessage(msg));
        } catch (e) {
          console.error("fetchFromGmail getMessage failed", (e as Error)?.message);
        }
      }
      if (out.length > 0) return out;
    } catch (e) {
      console.error("fetchFromGmail listMessages failed", (e as Error)?.message);
    }
  }
  return [];
}

export function getModel(modelId = "google/gemini-2.5-flash") {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  return createLovableAiGatewayProvider(key)(modelId);
}

export const EXTRACT_SCHEMA = z.object({
  name: z.string().nullable(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  linkedin: z.string().nullable(),
  twitter: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postal_code: z.string().nullable(),
  country: z.string().nullable(),
  // Best-guess industry / category for the contact's employer, drawn from
  // a fixed vocabulary. Used by contact_group_rules to auto-route contacts
  // into labels like "Software" or "Automotive". null when unclear.
  ai_category: z
    .enum([
      "software",
      "automotive",
      "finance",
      "legal",
      "media",
      "healthcare",
      "retail",
      "manufacturing",
      "consulting",
      "real_estate",
      "education",
      "nonprofit",
      "government",
      "hospitality",
      "energy",
      "other",
    ])
    .nullable(),
});

export const ADDRESS_FIELDS = [
  "address_line1",
  "address_line2",
  "city",
  "region",
  "postal_code",
  "country",
] as const;

const BANNED_DOMAINS = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "notifications",
  "notification",
  "support",
  "info",
  "hello",
  "help",
  "mailer-daemon",
  "bounces",
  "postmaster",
]);

export function isLikelyHuman(addr: string | null): boolean {
  if (!addr) return false;
  const lower = addr.toLowerCase().trim();
  const local = lower.split("@")[0] || "";
  for (const b of BANNED_DOMAINS) if (local.includes(b)) return false;
  return /@/.test(lower);
}

/** Normalize a contact display name to "First Last" form. Returns null for garbage. */
export function normalizeName(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim();
  // Strip surrounding quotes / angle brackets
  s = s.replace(/^["'`<\s]+|["'`>\s]+$/g, "");
  // Drop trailing parenthetical noise like "(via Acme)" or "[External]"
  s = s.replace(/\s*[([][^)\]]*[)\]]\s*$/g, "");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  // Reject if it's actually an email address
  if (/@/.test(s) && /\.[a-z]{2,}$/i.test(s)) return null;

  // "Last, First [Middle]" → "First [Middle] Last" (single comma, no extra commas)
  const commaCount = (s.match(/,/g) ?? []).length;
  if (commaCount === 1) {
    const [last, rest] = s.split(",").map((x) => x.trim());
    if (last && rest && /^[\p{L}'’\-. ]+$/u.test(last) && /^[\p{L}'’\-. ]+$/u.test(rest)) {
      s = `${rest} ${last}`.replace(/\s+/g, " ").trim();
    }
  }

  // Title-case if ALL CAPS or all lowercase
  const isAllCaps = s === s.toUpperCase() && /[A-Z]/.test(s);
  const isAllLower = s === s.toLowerCase() && /[a-z]/.test(s);
  if (isAllCaps || isAllLower) {
    s = s
      .toLowerCase()
      .split(" ")
      .map((tok) =>
        tok
          .split("-")
          .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
          .join("-"),
      )
      .join(" ");
  }

  return s || null;
}

/** Sort key: first token of normalized name, falling back to email local-part. */
export function firstNameKey(name: string | null | undefined, email: string): string {
  const n = normalizeName(name ?? null);
  const tok = n ? n.split(" ")[0] : email.split("@")[0] || "";
  return tok.toLowerCase();
}

/** Pick the more complete name. Never replace a multi-token name with a prefix of itself. */
export function pickBetterName(
  existing: string | null | undefined,
  candidate: string | null | undefined,
): string | null {
  const e = normalizeName(existing ?? null);
  const c = normalizeName(candidate ?? null);
  if (!c) return e ?? null;
  if (!e) return c;
  const eTokens = e.split(" ").filter(Boolean);
  const cTokens = c.split(" ").filter(Boolean);
  const eLower = e.toLowerCase();
  const cLower = c.toLowerCase();
  if (cTokens.length < eTokens.length && (eLower.startsWith(cLower + " ") || eLower === cLower))
    return e;
  if (eTokens.length < cTokens.length && (cLower.startsWith(eLower + " ") || cLower === eLower))
    return c;
  return cTokens.length >= eTokens.length ? c : e;
}

const PHONE_NUMBER_RE = /^[+\d\s().,#*;:x/A-Za-z-]{3,60}$/;
export const phoneEntrySchema = z.object({
  label: z.string().trim().min(1).max(20),
  number: z
    .string()
    .transform((v) => v.replace(/[\s\u00A0]+/g, " ").trim())
    .pipe(z.string().min(3).max(60).regex(PHONE_NUMBER_RE, "Invalid phone format")),
  is_primary: z.boolean().optional(),
});

export const emailEntrySchema = z.object({
  label: z.string().trim().min(1).max(20),
  address: z.string().trim().toLowerCase().email().max(255),
  is_primary: z.boolean().optional(),
});
