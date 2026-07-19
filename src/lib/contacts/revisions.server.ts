// Snapshot/restore for contact rows. Used as a safety net around CardDAV PUTs
// so a partial vCard from iOS can't silently erase fields the user typed on
// the web. Snapshots include the decrypted contact + phones + group ids.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getContactDecrypted, type DecryptedContact } from "@/lib/sync/encrypted-reader";
import { setContactEncryptedFields } from "@/lib/sync/encrypted-writer";

export type ContactSnapshot = {
  contact: DecryptedContact;
  phones: Array<{
    label: string | null;
    number: string;
    is_primary: boolean;
    position: number;
  }>;
  group_ids: string[];
};

const MAX_REVISIONS_PER_CONTACT = 20;

/** Capture the current state of a contact into contact_revisions. Best-effort
 * — callers should not fail their main operation if this errors. */
export async function snapshotContact(
  userId: string,
  contactId: string,
  source: string,
): Promise<void> {
  const { row: contact } = await getContactDecrypted(contactId);
  if (!contact || contact.user_id !== userId) return;

  const { data: phones } = await supabaseAdmin
    .from("contact_phones")
    .select("label, number, is_primary, position")
    .eq("contact_id", contactId)
    .eq("user_id", userId)
    .order("position", { ascending: true });

  const { data: memberships } = await supabaseAdmin
    .from("contact_group_members")
    .select("group_id")
    .eq("contact_id", contactId)
    .eq("user_id", userId);

  const snapshot: ContactSnapshot = {
    contact,
    phones: (phones ?? []).map((p) => ({
      label: p.label,
      number: p.number,
      is_primary: !!p.is_primary,
      position: p.position ?? 0,
    })),
    group_ids: (memberships ?? []).map((m) => m.group_id),
  };

  await supabaseAdmin.from("contact_revisions").insert({
    user_id: userId,
    contact_id: contactId,
    source,
    snapshot: JSON.parse(JSON.stringify(snapshot)),
  });

  // Trim: keep the newest MAX_REVISIONS_PER_CONTACT rows per contact.
  const { data: extra } = await supabaseAdmin
    .from("contact_revisions")
    .select("id")
    .eq("contact_id", contactId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(MAX_REVISIONS_PER_CONTACT, MAX_REVISIONS_PER_CONTACT + 100);
  const toDelete = (extra ?? []).map((r) => r.id);
  if (toDelete.length > 0) {
    await supabaseAdmin.from("contact_revisions").delete().in("id", toDelete).eq("user_id", userId);
  }
}

/** Restore a contact to a saved snapshot. Overwrites plaintext columns,
 * encrypted fields, phones, and group membership. */
export async function restoreContactFromRevision(
  userId: string,
  revisionId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const { data: rev, error: fetchErr } = await supabaseAdmin
    .from("contact_revisions")
    .select("id, contact_id, snapshot")
    .eq("id", revisionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (fetchErr || !rev) return { ok: false, error: fetchErr?.message ?? "Revision not found" };

  const snap = rev.snapshot as unknown as ContactSnapshot;
  const contactId = rev.contact_id;
  const c = snap.contact;
  const nowIso = new Date().toISOString();

  // Before overwriting the current state, snapshot it too so "restore" is
  // itself undoable.
  await snapshotContact(userId, contactId, "restore_previous").catch(() => {});

  const { error: upErr } = await supabaseAdmin
    .from("contacts")
    .update({
      name: c.name,
      email: c.email,
      title: c.title,
      company: c.company,
      website: c.website,
      city: c.city,
      region: c.region,
      postal_code: c.postal_code,
      country: c.country,
      linkedin: c.linkedin,
      twitter: c.twitter,
      updated_at: nowIso,
    })
    .eq("id", contactId)
    .eq("user_id", userId);
  if (upErr) return { ok: false, error: upErr.message };

  const encErr = await setContactEncryptedFields({
    contact_id: contactId,
    notes: c.notes ?? "",
    address_line1: c.address_line1 ?? "",
    address_line2: c.address_line2 ?? "",
    phone: c.phone ?? "",
  });
  if (encErr.error) return { ok: false, error: encErr.error };

  // Phones: full replace from snapshot.
  await supabaseAdmin
    .from("contact_phones")
    .delete()
    .eq("contact_id", contactId)
    .eq("user_id", userId);
  if (snap.phones.length > 0) {
    await supabaseAdmin.from("contact_phones").insert(
      snap.phones.map((p, idx) => ({
        user_id: userId,
        contact_id: contactId,
        label: (p.label ?? "other").toLowerCase(),
        number: p.number,
        is_primary: p.is_primary,
        position: p.position ?? idx,
      })),
    );
  }

  // Group memberships: full replace from snapshot.
  await supabaseAdmin
    .from("contact_group_members")
    .delete()
    .eq("contact_id", contactId)
    .eq("user_id", userId);
  if (snap.group_ids.length > 0) {
    await supabaseAdmin.from("contact_group_members").insert(
      snap.group_ids.map((group_id) => ({
        user_id: userId,
        contact_id: contactId,
        group_id,
      })),
    );
  }

  return { ok: true, error: null };
}
