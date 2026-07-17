// Push: propagate local Zerrow contact + group changes to Google People API.
// Runs AFTER pull so we always have fresh etags. Etag conflicts are logged
// and skipped — the next pull → push cycle will reconcile them.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logInfo, logError } from "@/lib/log.server";
import {
  createPerson,
  updatePerson,
  deletePerson,
  createContactGroup,
  updateContactGroup,
  deleteContactGroup,
  modifyGroupMembers,
  PeopleApiError,
} from "./people-client.server";
import { contactToPerson, groupToLabel } from "./mapper";
import { loadLocalContact } from "./state.server";

type Ids = { userId: string; gmailAccountId: string; runId: string };

// Cap per-run work so a big first-time push doesn't hog the cron slot.
const MAX_CONTACTS_PER_RUN = 200;
const MAX_GROUPS_PER_RUN = 100;

export async function pushToGoogle(ids: Ids): Promise<{
  contactsPushed: number;
  groupsPushed: number;
  tombstonesApplied: number;
}> {
  logInfo("google_contacts.push.start", { ...ids });
  const groupsPushed = await pushGroups(ids);
  const groupResourceByLocal = await loadGroupMap(ids);
  const contactsPushed = await pushContacts(ids, groupResourceByLocal);
  const tombstonesApplied = await applyTombstones(ids);
  logInfo("google_contacts.push.done", {
    ...ids,
    contacts: contactsPushed,
    groups: groupsPushed,
    tombstones: tombstonesApplied,
  });
  return { contactsPushed, groupsPushed, tombstonesApplied };
}

async function loadGroupMap(ids: Ids): Promise<Map<string, string>> {
  const { data } = await supabaseAdmin
    .from("google_group_links")
    .select("contact_group_id, resource_name")
    .eq("gmail_account_id", ids.gmailAccountId);
  return new Map((data ?? []).map((r) => [r.contact_group_id, r.resource_name]));
}

async function pushGroups(ids: Ids): Promise<number> {
  // All local groups + linked resource (LEFT JOIN via two queries).
  const { data: groups } = await supabaseAdmin
    .from("contact_groups")
    .select("id, name, updated_at")
    .eq("user_id", ids.userId)
    .order("updated_at", { ascending: true })
    .limit(MAX_GROUPS_PER_RUN);
  if (!groups?.length) return 0;

  const { data: links } = await supabaseAdmin
    .from("google_group_links")
    .select("contact_group_id, resource_name, etag, last_synced_at")
    .eq("gmail_account_id", ids.gmailAccountId);
  const byLocal = new Map(
    (links ?? []).map((l) => [l.contact_group_id, l]),
  );

  let count = 0;
  for (const g of groups) {
    const link = byLocal.get(g.id);
    try {
      if (!link) {
        const created = await createContactGroup(ids.gmailAccountId, g.name);
        if (created.resourceName) {
          await supabaseAdmin.from("google_group_links").insert({
            user_id: ids.userId,
            gmail_account_id: ids.gmailAccountId,
            contact_group_id: g.id,
            resource_name: created.resourceName,
            etag: created.etag ?? null,
          });
          count++;
        }
      } else if (link.last_synced_at && new Date(g.updated_at) > new Date(link.last_synced_at)) {
        const updated = await updateContactGroup(ids.gmailAccountId, link.resource_name, g.name);
        await supabaseAdmin
          .from("google_group_links")
          .update({ etag: updated.etag ?? null, last_synced_at: new Date().toISOString() })
          .eq("contact_group_id", g.id)
          .eq("gmail_account_id", ids.gmailAccountId);
        count++;
      }
    } catch (e) {
      logError("google_contacts.push.group_failed", { ...ids, group_id: g.id }, e);
    }
  }
  return count;
}

type ContactRow = {
  id: string;
  email: string;
  updated_at: string;
};

async function pushContacts(
  ids: Ids,
  groupResourceByLocal: Map<string, string>,
): Promise<number> {
  const { data: contacts } = await supabaseAdmin
    .from("contacts")
    .select("id, email, updated_at")
    .eq("user_id", ids.userId)
    .order("updated_at", { ascending: true })
    .limit(MAX_CONTACTS_PER_RUN);
  if (!contacts?.length) return 0;

  const { data: links } = await supabaseAdmin
    .from("google_contact_links")
    .select("contact_id, resource_name, etag, last_synced_at")
    .eq("gmail_account_id", ids.gmailAccountId);
  const byLocal = new Map(
    (links ?? []).map((l) => [l.contact_id, l]),
  );

  let count = 0;
  for (const c of contacts as ContactRow[]) {
    const link = byLocal.get(c.id);
    // Skip if remote is fresher than local (nothing to push).
    if (link?.last_synced_at && new Date(c.updated_at) <= new Date(link.last_synced_at)) continue;

    try {
      const local = await loadLocalContact(c.id);
      if (!local) continue;

      const { data: phones } = await supabaseAdmin
        .from("contact_phones")
        .select("label, number, is_primary")
        .eq("contact_id", c.id)
        .order("position", { ascending: true });

      const { data: memberships } = await supabaseAdmin
        .from("contact_group_members")
        .select("group_id")
        .eq("contact_id", c.id);
      const memberResourceNames = (memberships ?? [])
        .map((m) => groupResourceByLocal.get(m.group_id))
        .filter((n): n is string => !!n);

      const body = contactToPerson(local, phones ?? [], memberResourceNames);

      if (!link) {
        const created = await createPerson(ids.gmailAccountId, body);
        if (created.resourceName) {
          await supabaseAdmin.from("google_contact_links").upsert(
            {
              user_id: ids.userId,
              gmail_account_id: ids.gmailAccountId,
              contact_id: c.id,
              resource_name: created.resourceName,
              etag: created.etag ?? null,
              last_synced_at: new Date().toISOString(),
            },
            { onConflict: "gmail_account_id,contact_id" },
          );
          count++;
        }
      } else if (link.etag) {
        try {
          const updated = await updatePerson(ids.gmailAccountId, link.resource_name, {
            ...body,
            etag: link.etag,
          });
          await supabaseAdmin
            .from("google_contact_links")
            .update({ etag: updated.etag ?? null, last_synced_at: new Date().toISOString() })
            .eq("contact_id", c.id)
            .eq("gmail_account_id", ids.gmailAccountId);
          count++;
        } catch (e) {
          if (e instanceof PeopleApiError && e.isEtagConflict) {
            logInfo("google_contacts.push.etag_conflict_skip", { ...ids, contact_id: c.id });
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      logError("google_contacts.push.contact_failed", { ...ids, contact_id: c.id }, e);
    }
  }
  return count;
}

async function applyTombstones(ids: Ids): Promise<number> {
  const { data: tombs } = await supabaseAdmin
    .from("google_contact_tombstones")
    .select("id, kind, resource_name")
    .eq("gmail_account_id", ids.gmailAccountId)
    .limit(200);
  if (!tombs?.length) return 0;

  let applied = 0;
  for (const t of tombs) {
    try {
      if (t.kind === "contact") await deletePerson(ids.gmailAccountId, t.resource_name);
      else if (t.kind === "group") await deleteContactGroup(ids.gmailAccountId, t.resource_name);
      await supabaseAdmin.from("google_contact_tombstones").delete().eq("id", t.id);
      applied++;
    } catch (e) {
      // 404 → already gone upstream: clear the tombstone anyway.
      if (e instanceof PeopleApiError && e.status === 404) {
        await supabaseAdmin.from("google_contact_tombstones").delete().eq("id", t.id);
        applied++;
        continue;
      }
      logError(
        "google_contacts.push.tombstone_failed",
        { ...ids, kind: t.kind, resource_name: t.resource_name },
        e,
      );
    }
  }
  return applied;
}

/** Reconcile membership deltas as a single members:modify per group. */
export async function pushGroupMemberships(ids: Ids): Promise<void> {
  const { data: links } = await supabaseAdmin
    .from("google_group_links")
    .select("contact_group_id, resource_name")
    .eq("gmail_account_id", ids.gmailAccountId);
  if (!links?.length) return;

  const { data: contactLinks } = await supabaseAdmin
    .from("google_contact_links")
    .select("contact_id, resource_name")
    .eq("gmail_account_id", ids.gmailAccountId);
  const contactResourceById = new Map((contactLinks ?? []).map((l) => [l.contact_id, l.resource_name]));

  for (const gl of links) {
    // Desired member resource names.
    const { data: members } = await supabaseAdmin
      .from("contact_group_members")
      .select("contact_id")
      .eq("group_id", gl.contact_group_id);
    const desired = new Set(
      (members ?? [])
        .map((m) => contactResourceById.get(m.contact_id))
        .filter((n): n is string => !!n),
    );

    // Google's current members require a separate fetch — but for
    // simplicity, we add everything and rely on Google's idempotency.
    if (!desired.size) continue;
    try {
      await modifyGroupMembers(ids.gmailAccountId, gl.resource_name, [...desired], []);
    } catch (e) {
      logError(
        "google_contacts.push.membership_failed",
        { ...ids, resource_name: gl.resource_name },
        e,
      );
    }
  }
}
