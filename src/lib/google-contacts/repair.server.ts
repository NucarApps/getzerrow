// On-demand repair helpers for Google Contacts sync.
//
// These are strictly ADDITIVE: they pull the current state of a Google Person
// and insert any emails / phones that exist upstream but are missing locally.
// They never delete rows, never flip an existing primary, and never push.
//
// Rationale: the initial `contact_emails` backfill only copied the single
// legacy `contacts.email` column, so secondary emails that lived only in
// Google or on iOS never made it into the new table. This module lets the
// user recover them without risking overwrite of local edits.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logInfo, logError } from "@/lib/log.server";
import { getPerson, PeopleApiError } from "./people-client.server";
import { personToContact } from "./mapper";

type Ids = { userId: string; gmailAccountId: string };

type LinkRow = {
  contact_id: string;
  resource_name: string;
  gmail_account_id: string;
};

async function findLinkForContact(userId: string, contactId: string): Promise<LinkRow | null> {
  const { data } = await supabaseAdmin
    .from("google_contact_links")
    .select("contact_id, resource_name, gmail_account_id")
    .eq("user_id", userId)
    .eq("contact_id", contactId)
    .limit(1)
    .maybeSingle();
  return (data as LinkRow | null) ?? null;
}

/**
 * Additively merge Google Person emails / phones into local tables.
 * Returns counts of newly-inserted rows.
 */
async function mergeAdditive(
  ids: Ids,
  contactId: string,
  parsed: ReturnType<typeof personToContact>,
): Promise<{ emailsAdded: number; phonesAdded: number }> {
  let emailsAdded = 0;
  let phonesAdded = 0;

  // Emails
  if (parsed.emails.length) {
    const { data: existing } = await supabaseAdmin
      .from("contact_emails")
      .select("address, position, is_primary")
      .eq("contact_id", contactId);
    const existingSet = new Set((existing ?? []).map((r) => (r.address ?? "").toLowerCase()));
    const hasPrimary = (existing ?? []).some((r) => r.is_primary);
    const startPos = (existing ?? []).reduce((m, r) => Math.max(m, r.position ?? 0), -1) + 1;
    const toInsert = parsed.emails
      .filter((e) => e.address && !existingSet.has(e.address.toLowerCase()))
      .map((e, idx) => ({
        user_id: ids.userId,
        contact_id: contactId,
        label: e.label || "other",
        address: e.address.toLowerCase(),
        // Only promote a new email to primary if the contact has none.
        is_primary: !hasPrimary && idx === 0,
        position: startPos + idx,
      }));
    if (toInsert.length) {
      const { error } = await supabaseAdmin.from("contact_emails").insert(toInsert);
      if (error) throw new Error(`contact_emails insert failed: ${error.message}`);
      emailsAdded = toInsert.length;
    }
  }

  // Phones (same additive approach — dedupe by normalised digits)
  if (parsed.phones.length) {
    const normalize = (s: string) => s.replace(/[^\d+]/g, "");
    const { data: existing } = await supabaseAdmin
      .from("contact_phones")
      .select("number, position, is_primary")
      .eq("contact_id", contactId);
    const existingSet = new Set((existing ?? []).map((r) => normalize(r.number ?? "")));
    const hasPrimary = (existing ?? []).some((r) => r.is_primary);
    const startPos = (existing ?? []).reduce((m, r) => Math.max(m, r.position ?? 0), -1) + 1;
    const toInsert = parsed.phones
      .filter((p) => p.number && !existingSet.has(normalize(p.number)))
      .map((p, idx) => ({
        user_id: ids.userId,
        contact_id: contactId,
        label: p.label || "other",
        number: p.number,
        is_primary: !hasPrimary && idx === 0,
        position: startPos + idx,
      }));
    if (toInsert.length) {
      const { error } = await supabaseAdmin.from("contact_phones").insert(toInsert);
      if (error) throw new Error(`contact_phones insert failed: ${error.message}`);
      phonesAdded = toInsert.length;
    }
  }

  return { emailsAdded, phonesAdded };
}

async function markLinkFresh(
  gmailAccountId: string,
  resourceName: string,
  etag: string | null,
): Promise<void> {
  await supabaseAdmin
    .from("google_contact_links")
    .update({ etag, last_synced_at: new Date().toISOString() })
    .eq("gmail_account_id", gmailAccountId)
    .eq("resource_name", resourceName);
}

/** Re-pull a single contact from Google and additively merge missing emails/phones. */
export async function repullContact(
  userId: string,
  contactId: string,
): Promise<{
  ok: boolean;
  emailsAdded: number;
  phonesAdded: number;
  reason?: string;
}> {
  const link = await findLinkForContact(userId, contactId);
  if (!link) return { ok: false, emailsAdded: 0, phonesAdded: 0, reason: "not_linked" };

  let person;
  try {
    person = await getPerson(link.gmail_account_id, link.resource_name);
  } catch (e) {
    if (e instanceof PeopleApiError && e.status === 404) {
      return { ok: false, emailsAdded: 0, phonesAdded: 0, reason: "not_found_in_google" };
    }
    logError("google_contacts.repair.get_failed", { userId, contactId }, e);
    return {
      ok: false,
      emailsAdded: 0,
      phonesAdded: 0,
      reason: e instanceof Error ? e.message : "fetch_failed",
    };
  }

  const parsed = personToContact(person);
  const { emailsAdded, phonesAdded } = await mergeAdditive(
    { userId, gmailAccountId: link.gmail_account_id },
    contactId,
    parsed,
  );

  await markLinkFresh(link.gmail_account_id, link.resource_name, person.etag ?? null);
  logInfo("google_contacts.repair.repull_done", {
    userId,
    contactId,
    emailsAdded,
    phonesAdded,
  });

  return { ok: true, emailsAdded, phonesAdded };
}

/**
 * Scan every linked contact for the account and additively import missing
 * emails / phones from Google. Never deletes. Returns a summary.
 */
export async function backfillMultiEmails(
  userId: string,
  gmailAccountId: string,
  opts: { limit?: number } = {},
): Promise<{
  contactsScanned: number;
  contactsUpdated: number;
  emailsAdded: number;
  phonesAdded: number;
  failed: number;
}> {
  const limit = Math.max(1, Math.min(opts.limit ?? 5000, 20_000));
  const { data: links, error } = await supabaseAdmin
    .from("google_contact_links")
    .select("contact_id, resource_name, gmail_account_id")
    .eq("user_id", userId)
    .eq("gmail_account_id", gmailAccountId)
    .limit(limit);
  if (error) throw new Error(`load links failed: ${error.message}`);

  let contactsScanned = 0;
  let contactsUpdated = 0;
  let emailsAdded = 0;
  let phonesAdded = 0;
  let failed = 0;

  for (const link of (links ?? []) as LinkRow[]) {
    contactsScanned++;
    try {
      const person = await getPerson(gmailAccountId, link.resource_name);
      const parsed = personToContact(person);
      const res = await mergeAdditive({ userId, gmailAccountId }, link.contact_id, parsed);
      if (res.emailsAdded || res.phonesAdded) {
        contactsUpdated++;
        emailsAdded += res.emailsAdded;
        phonesAdded += res.phonesAdded;
      }
    } catch (e) {
      failed++;
      if (e instanceof PeopleApiError && e.status === 404) continue;
      logError(
        "google_contacts.repair.backfill_item_failed",
        { userId, gmailAccountId, contact_id: link.contact_id },
        e,
      );
    }
  }

  logInfo("google_contacts.repair.backfill_done", {
    userId,
    gmailAccountId,
    contactsScanned,
    contactsUpdated,
    emailsAdded,
    phonesAdded,
    failed,
  });

  return { contactsScanned, contactsUpdated, emailsAdded, phonesAdded, failed };
}
