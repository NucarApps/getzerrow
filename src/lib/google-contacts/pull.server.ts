// Pull: incremental fetch of Google People/contactGroups into Zerrow.
// Uses the sync-token flow; falls back to a full resync on EXPIRED_SYNC_TOKEN.
// All local writes go through the existing encrypted-writer / plain tables —
// nothing here re-implements CRUD.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { setContactEncryptedFields } from "@/lib/sync/encrypted-writer";
import { logInfo, logError } from "@/lib/log.server";
import {
  listConnectionsPage,
  listContactGroupsPage,
  PeopleApiError,
  type ConnectionsPage,
  type GroupsPage,
  type ContactGroup,
} from "./people-client.server";
import { personToContact, labelToGroupName, type Person } from "./mapper";
import { loadSyncState, updateSyncState, ensureSyncState } from "./state.server";
import { isLocalGoogleContactDirty } from "./dirty";
import type { ProgressReporter } from "./progress.server";

type Ids = { userId: string; gmailAccountId: string; runId: string };

const MAX_PAGES = 20;

async function paginateConnections(
  accountId: string,
  syncToken: string | null,
): Promise<{ persons: Person[]; deletions: string[]; nextSyncToken: string | null; usedFull: boolean }> {
  const persons: Person[] = [];
  const deletions: string[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  let usedFull = !syncToken;
  let useToken = syncToken ?? undefined;

  for (let i = 0; i < MAX_PAGES; i++) {
    let page: ConnectionsPage;
    try {
      page = await listConnectionsPage(accountId, {
        pageToken,
        syncToken: useToken,
        requestSyncToken: true,
      });
    } catch (e) {
      if (e instanceof PeopleApiError && e.isExpiredSyncToken && useToken) {
        // Restart without token.
        useToken = undefined;
        usedFull = true;
        pageToken = undefined;
        persons.length = 0;
        deletions.length = 0;
        continue;
      }
      throw e;
    }
    for (const p of page.connections ?? []) {
      if (p.metadata?.deleted && p.resourceName) deletions.push(p.resourceName);
      else persons.push(p);
    }
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return { persons, deletions, nextSyncToken, usedFull };
}

async function paginateGroups(
  accountId: string,
  syncToken: string | null,
): Promise<{ groups: ContactGroup[]; deletions: string[]; nextSyncToken: string | null }> {
  const groups: ContactGroup[] = [];
  const deletions: string[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  let useToken = syncToken ?? undefined;

  for (let i = 0; i < MAX_PAGES; i++) {
    let page: GroupsPage;
    try {
      page = await listContactGroupsPage(accountId, {
        pageToken,
        syncToken: useToken,
      });
    } catch (e) {
      if (e instanceof PeopleApiError && e.isExpiredSyncToken && useToken) {
        useToken = undefined;
        pageToken = undefined;
        groups.length = 0;
        deletions.length = 0;
        continue;
      }
      throw e;
    }
    for (const g of page.contactGroups ?? []) {
      if (!g.resourceName) continue;
      // Google marks group deletions with an empty payload + system flag? In
      // practice sync feeds return deletions in `deleted` fields; we treat
      // groups whose `name` is missing as tombstones defensively.
      if (!g.name && !g.formattedName) deletions.push(g.resourceName);
      else groups.push(g);
    }
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return { groups, deletions, nextSyncToken };
}

export type PullBreakdown = {
  created: number;
  updated: number;
  skipped_no_email: number;
  merged_duplicate_email: number;
  merged_by_phone: number;
  failed: number;
};


/** Apply pulled people/groups to local Zerrow state. Returns the count applied. */
export async function pullFromGoogle(
  ids: Ids,
  progress?: ProgressReporter,
): Promise<{
  pulled: number;
  peopleSyncToken: string | null;
  groupsSyncToken: string | null;
  usedFullResync: boolean;
  breakdown: PullBreakdown;
}> {
  const state = await loadSyncState(ids.userId, ids.gmailAccountId);
  if (!state) throw new Error("google_sync_state row missing");

  logInfo("google_contacts.pull.start", { ...ids, has_token: !!state.people_sync_token });

  await progress?.set("pulling_groups", 0, 0);
  const groupsResult = await paginateGroups(ids.gmailAccountId, state.groups_sync_token);
  await progress?.set(
    "pulling_groups",
    0,
    groupsResult.groups.length + groupsResult.deletions.length,
  );
  await applyGroupChanges(ids, groupsResult.groups, groupsResult.deletions);

  await progress?.set("pulling_contacts", 0, 0);
  const peopleResult = await paginateConnections(ids.gmailAccountId, state.people_sync_token);
  const peopleTotal = peopleResult.persons.length + peopleResult.deletions.length;
  await progress?.set("pulling_contacts", 0, peopleTotal);
  const breakdown: PullBreakdown = {
    created: 0,
    updated: 0,
    skipped_no_email: 0,
    merged_duplicate_email: 0,
    merged_by_phone: 0,
    failed: 0,
  };

  await applyPersonChanges(ids, peopleResult.persons, peopleResult.deletions, breakdown, progress);

  logInfo("google_contacts.pull.done", {
    ...ids,
    persons: peopleResult.persons.length,
    deletions: peopleResult.deletions.length,
    groups: groupsResult.groups.length,
    used_full: peopleResult.usedFull,
    ...breakdown,
  });

  return {
    pulled: peopleResult.persons.length + peopleResult.deletions.length,
    peopleSyncToken: peopleResult.nextSyncToken,
    groupsSyncToken: groupsResult.nextSyncToken,
    usedFullResync: peopleResult.usedFull,
    breakdown,
  };
}

async function applyGroupChanges(
  ids: Ids,
  groups: ContactGroup[],
  deletions: string[],
): Promise<void> {
  if (!groups.length && !deletions.length) return;

  // Existing links so we know which local group to update.
  const { data: links } = await supabaseAdmin
    .from("google_group_links")
    .select("contact_group_id, resource_name, etag")
    .eq("gmail_account_id", ids.gmailAccountId);
  const byResource = new Map<string, { contact_group_id: string; etag: string | null }>(
    (links ?? []).map((l) => [l.resource_name, { contact_group_id: l.contact_group_id, etag: l.etag ?? null }]),
  );

  for (const g of groups) {
    const name = labelToGroupName(g);
    if (!name || !g.resourceName) continue;

    const existing = byResource.get(g.resourceName);
    if (existing) {
      await supabaseAdmin
        .from("contact_groups")
        .update({ name })
        .eq("id", existing.contact_group_id);
      await supabaseAdmin
        .from("google_group_links")
        .update({ etag: g.etag ?? null, last_synced_at: new Date().toISOString() })
        .eq("gmail_account_id", ids.gmailAccountId)
        .eq("resource_name", g.resourceName);
    } else {
      // Create a Zerrow group and link.
      const { data: created, error: cErr } = await supabaseAdmin
        .from("contact_groups")
        .insert({
          user_id: ids.userId,
          name,
          carddav_uid: crypto.randomUUID(),
        })
        .select("id")
        .single();
      if (cErr || !created) {
        logError("google_contacts.pull.group_create_failed", { ...ids, name }, cErr);
        continue;
      }
      await supabaseAdmin.from("google_group_links").insert({
        user_id: ids.userId,
        gmail_account_id: ids.gmailAccountId,
        contact_group_id: created.id,
        resource_name: g.resourceName,
        etag: g.etag ?? null,
      });
    }
  }

  for (const rn of deletions) {
    const existing = byResource.get(rn);
    if (!existing) continue;
    // Skip cascade if the group has members — safer default is to just unlink.
    await supabaseAdmin
      .from("google_group_links")
      .delete()
      .eq("gmail_account_id", ids.gmailAccountId)
      .eq("resource_name", rn);
  }
}

async function applyPersonChanges(
  ids: Ids,
  persons: Person[],
  deletions: string[],
  breakdown: PullBreakdown,
  progress?: ProgressReporter,
): Promise<void> {
  if (!persons.length && !deletions.length) return;
  const touchedContactIds = new Set<string>();

  const { data: links } = await supabaseAdmin
    .from("google_contact_links")
    .select("contact_id, resource_name, etag, last_synced_at")
    .eq("gmail_account_id", ids.gmailAccountId);
  const byResource = new Map<string, { contact_id: string; last_synced_at: string | null }>(
    (links ?? []).map((l) => [
      l.resource_name,
      { contact_id: l.contact_id, last_synced_at: l.last_synced_at ?? null },
    ]),
  );

  // Existing group links for membership diffing.
  const { data: groupLinks } = await supabaseAdmin
    .from("google_group_links")
    .select("contact_group_id, resource_name")
    .eq("gmail_account_id", ids.gmailAccountId);
  const groupByResource = new Map<string, string>(
    (groupLinks ?? []).map((g) => [g.resource_name, g.contact_group_id]),
  );

  for (const p of persons) {
    if (!p.resourceName) continue;
    const parsed = personToContact(p);
    const hasIdentity =
      !!parsed.email ||
      !!parsed.patch.name ||
      !!parsed.patch.company ||
      parsed.phones.length > 0 ||
      !!parsed.patch.primary_phone;
    if (!hasIdentity) {
      // Truly empty entry — no email, no name, no phone, no company.
      breakdown.skipped_no_email++;
      await progress?.increment(1);
      continue;
    }

    const link = byResource.get(p.resourceName);
    let contactId = link?.contact_id ?? null;
    let didCreate = false;
    let didMerge = false;

    let mergedByPhone = false;
    if (!contactId) {
      // If the Google person has an email, prefer merging into any existing
      // Zerrow contact with the same email (email is the natural key when
      // present). Otherwise fall back to phone / name+phone / name+company
      // matches against emailless contacts.
      if (parsed.email) {
        const { data: existing } = await supabaseAdmin
          .from("contacts")
          .select("id")
          .eq("user_id", ids.userId)
          .eq("email", parsed.email.toLowerCase())
          .maybeSingle();
        if (existing) {
          contactId = existing.id;
          didMerge = true;
        }
      }
      if (!contactId) {
        const { findEmaillessDuplicate } = await import(
          "@/lib/contacts/dedup.server"
        );
        const phoneNumbers: string[] = [
          ...parsed.phones.map((p) => p.number),
          ...(parsed.patch.primary_phone ? [parsed.patch.primary_phone] : []),
        ];
        const dupId = await findEmaillessDuplicate({
          userId: ids.userId,
          name: parsed.patch.name ?? null,
          company: parsed.patch.company ?? null,
          phones: phoneNumbers,
        });
        if (dupId) {
          contactId = dupId;
          didMerge = true;
          mergedByPhone = true;
        }
      }

      if (!contactId) {
        const { data: created, error: cErr } = await supabaseAdmin
          .from("contacts")
          .insert({
            user_id: ids.userId,
            email: parsed.email ? parsed.email.toLowerCase() : null,
            source: "google",
            name: parsed.patch.name ?? null,
            company: parsed.patch.company ?? null,
            title: parsed.patch.title ?? null,
            website: parsed.patch.website ?? null,
            linkedin: parsed.patch.linkedin ?? null,
            twitter: parsed.patch.twitter ?? null,
            city: parsed.patch.city ?? null,
            region: parsed.patch.region ?? null,
            postal_code: parsed.patch.postal_code ?? null,
            country: parsed.patch.country ?? null,
          })
          .select("id")
          .single();
        if (cErr || !created) {
          logError(
            "google_contacts.pull.contact_create_failed",
            { ...ids, email: parsed.email ?? null, resource: p.resourceName },
            cErr,
          );
          breakdown.failed++;
          await progress?.increment(1);
          continue;
        }
        contactId = created.id;
        didCreate = true;
      }
      await supabaseAdmin.from("google_contact_links").upsert(
        {
          user_id: ids.userId,
          gmail_account_id: ids.gmailAccountId,
          contact_id: contactId,
          resource_name: p.resourceName,
          etag: p.etag ?? null,
        },
        { onConflict: "gmail_account_id,contact_id" },
      );
    } else {
      if (!link) {
        await progress?.increment(1);
        continue;
      }
      const { data: localBeforePull } = await supabaseAdmin
        .from("contacts")
        .select("updated_at")
        .eq("id", contactId)
        .eq("user_id", ids.userId)
        .maybeSingle();
      if (isLocalGoogleContactDirty(localBeforePull?.updated_at ?? null, link.last_synced_at)) {
        await supabaseAdmin
          .from("google_contact_links")
          .update({ etag: p.etag ?? null })
          .eq("gmail_account_id", ids.gmailAccountId)
          .eq("resource_name", p.resourceName);
        await progress?.increment(1);
        continue;
      }

      // Update plaintext fields.
      const plainPatch = {
        email: parsed.email ? parsed.email.toLowerCase() : null,
        name: parsed.patch.name ?? null,
        company: parsed.patch.company ?? null,
        title: parsed.patch.title ?? null,
        website: parsed.patch.website ?? null,
        linkedin: parsed.patch.linkedin ?? null,
        twitter: parsed.patch.twitter ?? null,
        city: parsed.patch.city ?? null,
        region: parsed.patch.region ?? null,
        postal_code: parsed.patch.postal_code ?? null,
        country: parsed.patch.country ?? null,
      };
      await supabaseAdmin.from("contacts").update(plainPatch).eq("id", contactId);
    }

    if (didCreate) breakdown.created++;
    else if (mergedByPhone) breakdown.merged_by_phone++;
    else if (didMerge) breakdown.merged_duplicate_email++;
    else breakdown.updated++;



    if (!contactId) continue;

    // Encrypted fields (notes, address, primary phone).
    await setContactEncryptedFields({
      contact_id: contactId,
      notes: parsed.patch.notes ?? null,
      address_line1: parsed.patch.address_line1 ?? null,
      address_line2: parsed.patch.address_line2 ?? null,
      phone: parsed.patch.primary_phone ?? null,
    });

    // Replace phones.
    await supabaseAdmin.from("contact_phones").delete().eq("contact_id", contactId);
    if (parsed.phones.length) {
      const rows = parsed.phones.map((ph, idx) => ({
        user_id: ids.userId,
        contact_id: contactId!,
        label: ph.label,
        number: ph.number,
        is_primary: ph.is_primary,
        position: idx,
      }));
      await supabaseAdmin.from("contact_phones").insert(rows);
    }

    // Membership diff.
    const desiredGroupIds = new Set(
      parsed.membershipResourceNames
        .map((rn) => groupByResource.get(rn))
        .filter((v): v is string => !!v),
    );
    const { data: currentMembers } = await supabaseAdmin
      .from("contact_group_members")
      .select("group_id")
      .eq("contact_id", contactId);
    const current = new Set((currentMembers ?? []).map((m) => m.group_id));
    const toAdd = [...desiredGroupIds].filter((g) => !current.has(g));
    const toRemove = [...current].filter((g) => !desiredGroupIds.has(g));
    if (toAdd.length) {
      await supabaseAdmin
        .from("contact_group_members")
        .insert(toAdd.map((g) => ({ user_id: ids.userId, contact_id: contactId!, group_id: g })));
    }
    if (toRemove.length) {
      await supabaseAdmin
        .from("contact_group_members")
        .delete()
        .eq("contact_id", contactId)
        .in("group_id", toRemove);
    }
    await supabaseAdmin.from("google_contact_links").upsert(
      {
        user_id: ids.userId,
        gmail_account_id: ids.gmailAccountId,
        contact_id: contactId,
        resource_name: p.resourceName,
        etag: p.etag ?? null,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "gmail_account_id,contact_id" },
    );
    if (contactId) touchedContactIds.add(contactId);
    await progress?.increment(1);
  }

  // Deletions from Google → hard-delete locally IF the contact is only linked
  // to Google (no other source). Simpler policy: just unlink and leave the
  // contact — user can still delete manually. Trigger-based tombstones would
  // otherwise re-push, so guard against that.
  for (const rn of deletions) {
    await supabaseAdmin
      .from("google_contact_links")
      .delete()
      .eq("gmail_account_id", ids.gmailAccountId)
      .eq("resource_name", rn);
    await progress?.increment(1);
  }

  // After the batch, reconcile any auto-company-subgroup parents that
  // include touched contacts so subgroups reflect the new company values.
  if (touchedContactIds.size > 0) {
    try {
      const { reconcileAutoParentsForContacts } = await import(
        "@/lib/contacts/auto-company-subgroups.functions"
      );
      await reconcileAutoParentsForContacts(
        supabaseAdmin,
        ids.userId,
        Array.from(touchedContactIds),
      );
    } catch (err) {
      logError("google_contacts.pull.auto_subgroup_reconcile_failed", ids, err);
    }
  }
}

/** Reset sync tokens — forces a full resync next tick. */
export async function forceFullResync(userId: string, gmailAccountId: string): Promise<void> {
  const state = await ensureSyncState(userId, gmailAccountId);
  await updateSyncState(state.id, {
    people_sync_token: null,
    groups_sync_token: null,
    last_error: null,
  });
}
