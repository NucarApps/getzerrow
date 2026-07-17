// Server-only dedup helpers used by the Google pull and the on-demand
// duplicate scanner. Never import from a client-reachable path.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizePhone, normalizePhones } from "./phone";

export type DupInput = {
  userId: string;
  name: string | null;
  company: string | null;
  phones: string[]; // raw numbers, will be normalized
};

/**
 * Best-effort lookup for an existing emailless contact that matches the
 * given identity signals. Used during Google pull so re-syncing a person
 * without an email doesn't create a fresh row every time.
 *
 * Rules (only match against contacts where email IS NULL, scoped to userId):
 *   1) phone match — any of the input phones (normalized) matches an
 *      existing contact_phones row
 *   2) name+phone match — if #1 finds multiple, prefer where lower(name)
 *      equals input.name
 *   3) name+company match — only when input has no phones, match on exact
 *      lower(name) + lower(company). Skip if 2+ candidates (ambiguous).
 *
 * Returns the contact id to merge into, or null when nothing safe matches.
 */
export async function findEmaillessDuplicate(
  input: DupInput,
): Promise<string | null> {
  const normPhones = normalizePhones(input.phones);
  const name = (input.name ?? "").trim().toLowerCase();
  const company = (input.company ?? "").trim().toLowerCase();

  if (normPhones.length > 0) {
    const { data: phoneRows } = await supabaseAdmin
      .from("contact_phones")
      .select("contact_id, number")
      .eq("user_id", input.userId);
    const matches = new Set<string>();
    for (const row of phoneRows ?? []) {
      const n = normalizePhone(row.number);
      if (n && normPhones.includes(n)) matches.add(row.contact_id);
    }
    if (matches.size > 0) {
      const ids = Array.from(matches);
      const { data: candidates } = await supabaseAdmin
        .from("contacts")
        .select("id, name, email")
        .eq("user_id", input.userId)
        .in("id", ids);
      const emailless = (candidates ?? []).filter((c) => !c.email);
      if (emailless.length === 1) return emailless[0].id;
      if (emailless.length > 1 && name) {
        const nameHit = emailless.find(
          (c) => (c.name ?? "").trim().toLowerCase() === name,
        );
        if (nameHit) return nameHit.id;
        // Fall back to the first match — better than making yet another dupe.
        return emailless[0].id;
      }
      if (emailless.length >= 1) return emailless[0].id;
    }
  } else if (name && company) {
    const { data: candidates } = await supabaseAdmin
      .from("contacts")
      .select("id, name, company, email")
      .eq("user_id", input.userId)
      .is("email", null)
      .ilike("name", name)
      .ilike("company", company);
    if ((candidates ?? []).length === 1) return candidates![0].id;
  }
  return null;
}
