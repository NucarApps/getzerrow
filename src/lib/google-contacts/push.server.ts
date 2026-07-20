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
  getPerson,
  PeopleApiError,
} from "./people-client.server";
import { contactToPerson, groupToLabel, personToContact } from "./mapper";
import { loadLocalContact } from "./state.server";
import { filterDirtyForPush, MAX_PHOTO_PUSH_ATTEMPTS } from "./dirty";

import type { ProgressReporter } from "./progress.server";

type Ids = { userId: string; gmailAccountId: string; runId: string };

// Cap per-run work so a big first-time push doesn't hog the cron slot.
const MAX_CONTACTS_PER_RUN = 200;
const MAX_GROUPS_PER_RUN = 100;

export async function pushToGoogle(
  ids: Ids,
  progress?: ProgressReporter,
): Promise<{
  contactsPushed: number;
  groupsPushed: number;
  tombstonesApplied: number;
}> {
  logInfo("google_contacts.push.start", { ...ids });
  await progress?.set("pushing_groups", 0, 0);
  const groupsPushed = await pushGroups(ids, progress);
  const groupResourceByLocal = await loadGroupMap(ids);
  await progress?.set("pushing_contacts", 0, 0);
  const contactsPushed = await pushContacts(ids, groupResourceByLocal, progress);
  await progress?.set("applying_tombstones", 0, 0);
  const tombstonesApplied = await applyTombstones(ids, progress);
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

async function pushGroups(ids: Ids, progress?: ProgressReporter): Promise<number> {
  // All local groups + linked resource (LEFT JOIN via two queries).
  const { data: groups } = await supabaseAdmin
    .from("contact_groups")
    .select("id, name, updated_at")
    .eq("user_id", ids.userId)
    .order("updated_at", { ascending: true })
    .limit(MAX_GROUPS_PER_RUN);
  if (!groups?.length) return 0;
  await progress?.set("pushing_groups", 0, groups.length);

  const { data: links } = await supabaseAdmin
    .from("google_group_links")
    .select("contact_group_id, resource_name, etag, last_synced_at")
    .eq("gmail_account_id", ids.gmailAccountId);
  const byLocal = new Map((links ?? []).map((l) => [l.contact_group_id, l]));

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
    await progress?.increment(1);
  }
  return count;
}

type ContactRow = {
  id: string;
  email: string | null;
  updated_at: string;
  avatar_url: string | null;
};

async function pushContacts(
  ids: Ids,
  groupResourceByLocal: Map<string, string>,
  progress?: ProgressReporter,
): Promise<number> {
  const { data: links } = await supabaseAdmin
    .from("google_contact_links")
    .select("contact_id, resource_name, etag, last_synced_at, photo_etag, photo_push_attempts")
    .eq("gmail_account_id", ids.gmailAccountId);
  const byLocal = new Map((links ?? []).map((l) => [l.contact_id, l]));

  // Two-pass dirty selection so photo-dirty contacts don't starve behind a
  // large body-dirty backlog. First pass targets contacts that need a photo
  // upload (avatar set + no photo_etag on the link). Second pass fills the
  // remaining per-run budget with body-dirty rows, oldest-updated first.
  const dirty: ContactRow[] = [];
  const seen = new Set<string>();
  const photoDirtyIds = (links ?? [])
    .filter(
      (l) =>
        (l.photo_etag == null) &&
        ((l.photo_push_attempts ?? 0) < MAX_PHOTO_PUSH_ATTEMPTS),
    )
    .map((l) => l.contact_id);
  if (photoDirtyIds.length) {
    const { data: photoRows } = await supabaseAdmin
      .from("contacts")
      .select("id, email, updated_at, avatar_url")
      .eq("user_id", ids.userId)
      .not("avatar_url", "is", null)
      .in("id", photoDirtyIds.slice(0, MAX_CONTACTS_PER_RUN));
    for (const r of (photoRows ?? []) as ContactRow[]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        dirty.push(r);
      }
    }
  }
  const PAGE_SIZE = 1000;
  for (let from = 0; dirty.length < MAX_CONTACTS_PER_RUN; from += PAGE_SIZE) {
    const { data: page } = await supabaseAdmin
      .from("contacts")
      .select("id, email, updated_at, avatar_url")
      .eq("user_id", ids.userId)
      .order("updated_at", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (!page?.length) break;
    for (const r of filterDirtyForPush(page as ContactRow[], byLocal)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      dirty.push(r);
      if (dirty.length >= MAX_CONTACTS_PER_RUN) break;
    }
    if (page.length < PAGE_SIZE) break;
  }
  const contacts = dirty.slice(0, MAX_CONTACTS_PER_RUN);

  if (!contacts.length) return 0;
  await progress?.set("pushing_contacts", 0, contacts.length);

  // Per-user preference: fold Zerrow's AI relationship summary into the NOTE
  // pushed to Google (mirrors the CardDAV path so iOS + Google Contacts show
  // the same block). Default on.
  const { data: settingsRow } = await supabaseAdmin
    .from("carddav_settings")
    .select("include_summary_in_notes")
    .eq("user_id", ids.userId)
    .maybeSingle();
  const includeSummary =
    (settingsRow as { include_summary_in_notes?: boolean } | null)?.include_summary_in_notes !==
    false;

  let count = 0;
  for (const c of contacts) {
    const link = byLocal.get(c.id);
    const linkPhotoEtag =
      (link as { photo_etag?: string | null } | undefined)?.photo_etag ?? null;
    const linkPhotoAttempts =
      (link as { photo_push_attempts?: number | null } | undefined)?.photo_push_attempts ?? 0;
    const currentAvatar = c.avatar_url ?? null;



    try {
      const local = await loadLocalContact(c.id);
      if (!local) continue;

      const { data: phones } = await supabaseAdmin
        .from("contact_phones")
        .select("label, number, is_primary")
        .eq("contact_id", c.id)
        .order("position", { ascending: true });

      const { data: emails } = await supabaseAdmin
        .from("contact_emails")
        .select("label, address, is_primary")
        .eq("contact_id", c.id)
        .order("position", { ascending: true });

      const { data: memberships } = await supabaseAdmin
        .from("contact_group_members")
        .select("group_id")
        .eq("contact_id", c.id);
      const memberResourceNames = (memberships ?? [])
        .map((m) => groupResourceByLocal.get(m.group_id))
        .filter((n): n is string => !!n);

      const body = contactToPerson(
        local,
        phones ?? [],
        memberResourceNames,
        undefined,
        (emails ?? []).map((e) => ({
          label: e.label,
          address: e.address,
          is_primary: e.is_primary,
        })),
        { includeSummary },
      );

      // Track the resource_name of a freshly-created Google contact so the
      // photo push below can attach the avatar in the same iteration.
      let createdResourceName: string | null = null;
      // When a guard decides the person body must not be pushed this run, we
      // skip the body update but still fall through to the photo push below —
      // the photo goes through its own endpoint and can't clobber fields.
      let skipBodyUpdate = false;
      if (!link) {
        const created = await createPerson(ids.gmailAccountId, body);
        if (created.resourceName) {
          createdResourceName = created.resourceName;
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
          // Conflict guard: if Google has emails we don't, abort the push
          // and flip the link back to "trust remote" so the next pull will
          // import the missing addresses instead of us clobbering them.
          try {
            const remote = await getPerson(ids.gmailAccountId, link.resource_name);
            const remoteEmails = new Set(
              (remote.emailAddresses ?? [])
                .map((e) => e.value?.trim().toLowerCase())
                .filter((v): v is string => !!v),
            );
            const localEmails = new Set(
              (emails ?? [])
                .map((e) => e.address?.trim().toLowerCase())
                .filter((v): v is string => !!v),
            );
            const remoteOnly = [...remoteEmails].filter((e) => !localEmails.has(e));
            if (remoteOnly.length > 0) {
              logInfo("google_contacts.push.remote_has_more_emails_skip", {
                ...ids,
                contact_id: c.id,
                remote_only_count: remoteOnly.length,
              });
              await supabaseAdmin
                .from("google_contact_links")
                .update({
                  etag: remote.etag ?? link.etag,
                  last_synced_at: new Date(0).toISOString(),
                })
                .eq("contact_id", c.id)
                .eq("gmail_account_id", ids.gmailAccountId);
              // Immediately additively import the remote-only emails so the
              // user sees them without waiting for the next full pull.
              const parsedRemote = personToContact(remote);
              const { data: existing } = await supabaseAdmin
                .from("contact_emails")
                .select("address, position, is_primary")
                .eq("contact_id", c.id);
              const existingSet = new Set(
                (existing ?? []).map((r) => (r.address ?? "").toLowerCase()),
              );
              const hasPrimary = (existing ?? []).some((r) => r.is_primary);
              const startPos =
                (existing ?? []).reduce((m, r) => Math.max(m, r.position ?? 0), -1) + 1;
              const toInsert = parsedRemote.emails
                .filter((e) => !existingSet.has(e.address.toLowerCase()))
                .map((e, idx) => ({
                  user_id: ids.userId,
                  contact_id: c.id,
                  label: e.label || "other",
                  address: e.address.toLowerCase(),
                  is_primary: !hasPrimary && idx === 0,
                  position: startPos + idx,
                }));
              if (toInsert.length) {
                await supabaseAdmin.from("contact_emails").insert(toInsert);
              }
              skipBodyUpdate = true;
            }
          } catch (guardErr) {
            // If the guard itself fails, fall through to the normal update
            // (the etag path still protects against silent overwrites).
            logError("google_contacts.push.guard_failed", { ...ids, contact_id: c.id }, guardErr);
          }

          if (!skipBodyUpdate) {
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
          }
        } catch (e) {
          if (e instanceof PeopleApiError && e.isEtagConflict) {
            logInfo("google_contacts.push.etag_conflict_skip", { ...ids, contact_id: c.id });
            skipBodyUpdate = true;
          } else {
            throw e;
          }
        }
      }

      // Photo push: upload the local avatar bytes to Google whenever the
      // avatar_url on record differs from the last URL we pushed
      // (`photo_etag`). Runs after the person body update so the People API
      // has a fresh Person to attach the photo to. Failures leave photo_etag
      // untouched and bump photo_push_attempts; after MAX_PHOTO_PUSH_ATTEMPTS
      // we stop retrying and log a give-up alert.
      try {
        const avatarUrl = currentAvatar;
        const previousUrl = linkPhotoEtag;
        const resource = link?.resource_name ?? createdResourceName;
        if (
          resource &&
          avatarUrl &&
          avatarUrl !== previousUrl &&
          linkPhotoAttempts < MAX_PHOTO_PUSH_ATTEMPTS
        ) {
          const { loadContactPhotoBytes } = await import("@/lib/contacts/photos.server");
          const { updateContactPhoto } = await import("./people-client.server");
          try {
            const photo = await loadContactPhotoBytes(avatarUrl);
            if (photo) {
              await updateContactPhoto(ids.gmailAccountId, resource, photo.bytes);
              await supabaseAdmin
                .from("google_contact_links")
                .update({ photo_etag: avatarUrl, photo_push_attempts: 0 })
                .eq("contact_id", c.id)
                .eq("gmail_account_id", ids.gmailAccountId);
            }
          } catch (uploadErr) {
            const nextAttempts = linkPhotoAttempts + 1;
            await supabaseAdmin
              .from("google_contact_links")
              .update({ photo_push_attempts: nextAttempts })
              .eq("contact_id", c.id)
              .eq("gmail_account_id", ids.gmailAccountId);
            if (nextAttempts >= MAX_PHOTO_PUSH_ATTEMPTS) {
              logError(
                "google_contacts.push.photo_gave_up",
                { ...ids, contact_id: c.id, attempts: nextAttempts },
                uploadErr,
              );
            } else {
              logError(
                "google_contacts.push.photo_failed",
                { ...ids, contact_id: c.id, attempts: nextAttempts },
                uploadErr,
              );
            }
          }
        }
      } catch (photoErr) {
        logError("google_contacts.push.photo_failed", { ...ids, contact_id: c.id }, photoErr);
      }
    } catch (e) {
      logError("google_contacts.push.contact_failed", { ...ids, contact_id: c.id }, e);
    }
    await progress?.increment(1);

  }
  return count;
}

async function applyTombstones(ids: Ids, progress?: ProgressReporter): Promise<number> {
  const { data: tombs } = await supabaseAdmin
    .from("google_contact_tombstones")
    .select("id, kind, resource_name")
    .eq("gmail_account_id", ids.gmailAccountId)
    .limit(200);
  if (!tombs?.length) return 0;
  await progress?.set("applying_tombstones", 0, tombs.length);

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
    await progress?.increment(1);
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
  const contactResourceById = new Map(
    (contactLinks ?? []).map((l) => [l.contact_id, l.resource_name]),
  );

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
