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
  getContactGroupWithMembers,
  getPerson,
  PeopleApiError,
} from "./people-client.server";
import { contactToPerson, groupToLabel, personToContact } from "./mapper";
import { loadLocalContact } from "./state.server";
import {
  calculateMembershipDelta,
  filterDirtyForPush,
  isGooglePhotoLinkDirty,
  MAX_PHOTO_PUSH_ATTEMPTS,
} from "./dirty";

import type { ProgressReporter } from "./progress.server";

type Ids = { userId: string; gmailAccountId: string; runId: string };

// Cap per-run work so a big first-time push doesn't hog the cron slot.
const MAX_CONTACTS_PER_RUN = 200;
const MAX_GROUPS_PER_RUN = 100;
const NO_LOCAL_PHOTO_ETAG = "no-local-photo";
// Wall-clock budget for the push loop. The whole runGoogleContactsSync request
// must finish inside the Worker/Safari fetch window (~30s) — this leaves room
// for pull + finalize before Safari drops the request as "Load failed" and the
// Worker is killed mid-loop (which leaks the sync lease). When exceeded we
// break cleanly; the next cron tick (or user click) resumes the remainder.
const PUSH_WALL_BUDGET_MS = 18_000;

export async function pushToGoogle(
  ids: Ids,
  progress?: ProgressReporter,
): Promise<{
  contactsPushed: number;
  groupsPushed: number;
  membershipsPushed: number;
  tombstonesApplied: number;
}> {
  logInfo("google_contacts.push.start", { ...ids });
  await progress?.set("pushing_groups", 0, 0);
  const groupsPushed = await pushGroups(ids, progress);
  const groupResourceByLocal = await loadGroupMap(ids);
  await progress?.set("pushing_contacts", 0, 0);
  const contactsPushed = await pushContacts(ids, groupResourceByLocal, progress);
  await progress?.set("pushing_memberships", 0, 0);
  const membershipsPushed = await pushGroupMemberships(ids, progress);
  await progress?.set("applying_tombstones", 0, 0);
  const tombstonesApplied = await applyTombstones(ids, progress);
  logInfo("google_contacts.push.done", {
    ...ids,
    contacts: contactsPushed,
    groups: groupsPushed,
    memberships: membershipsPushed,
    tombstones: tombstonesApplied,
  });
  return { contactsPushed, groupsPushed, membershipsPushed, tombstonesApplied };
}

async function loadGroupMap(ids: Ids): Promise<Map<string, string>> {
  const { data } = await supabaseAdmin
    .from("google_group_links")
    .select("contact_group_id, resource_name")
    .eq("gmail_account_id", ids.gmailAccountId);
  return new Map((data ?? []).map((r) => [r.contact_group_id, r.resource_name]));
}

/** Google Contacts labels are flat. Concatenate one level of local nesting
 *  as "Parent - Child" (e.g. "Factory - VW") so subgroups show up in Google
 *  under a recognizable prefix. Top-level groups keep their bare name. */
export function formatGoogleLabelName(
  name: string,
  parentGroupId: string | null,
  parentNameById: Map<string, string>,
): string {
  if (!parentGroupId) return name;
  const parent = parentNameById.get(parentGroupId);
  if (!parent) return name;
  if (name.startsWith(`${parent} - `)) return name;
  return `${parent} - ${name}`;
}

/** Google's default "Contacts" screen only shows members of the myContacts
 *  system group. Zerrow pushes contacts into user labels but must also add
 *  them here or they land in "Other contacts" and appear missing. */
export const MY_CONTACTS_RESOURCE = "contactGroups/myContacts";

export function withMyContacts(memberResourceNames: string[]): string[] {
  return memberResourceNames.includes(MY_CONTACTS_RESOURCE)
    ? memberResourceNames
    : [...memberResourceNames, MY_CONTACTS_RESOURCE];
}

async function pushGroups(ids: Ids, progress?: ProgressReporter): Promise<number> {
  // All local groups + linked resource (LEFT JOIN via two queries).
  const { data: groups } = await supabaseAdmin
    .from("contact_groups")
    .select("id, name, updated_at, parent_group_id")
    .eq("user_id", ids.userId)
    .order("updated_at", { ascending: true })
    .limit(MAX_GROUPS_PER_RUN);
  if (!groups?.length) return 0;
  await progress?.set("pushing_groups", 0, groups.length);

  const parentNameById = new Map<string, string>();
  for (const g of groups) parentNameById.set(g.id, g.name);

  const { data: links } = await supabaseAdmin
    .from("google_group_links")
    .select("contact_group_id, resource_name, etag, last_synced_at")
    .eq("gmail_account_id", ids.gmailAccountId);
  const byLocal = new Map((links ?? []).map((l) => [l.contact_group_id, l]));

  let count = 0;
  for (const g of groups) {
    const link = byLocal.get(g.id);
    const label = formatGoogleLabelName(g.name, g.parent_group_id ?? null, parentNameById);
    try {
      if (!link) {
        const created = await createContactGroup(ids.gmailAccountId, label);
        if (created.resourceName) {
          await supabaseAdmin.from("google_group_links").insert({
            user_id: ids.userId,
            gmail_account_id: ids.gmailAccountId,
            contact_group_id: g.id,
            resource_name: created.resourceName,
            etag: created.etag ?? null,
            last_synced_at: new Date().toISOString(),
          });
          count++;
        }
      } else if (link.last_synced_at && new Date(g.updated_at) > new Date(link.last_synced_at)) {
        const updated = await updateContactGroup(ids.gmailAccountId, link.resource_name, label);
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
  company_id: string | null;
};

async function pushContacts(
  ids: Ids,
  groupResourceByLocal: Map<string, string>,
  progress?: ProgressReporter,
): Promise<number> {
  const { data: links } = await supabaseAdmin
    .from("google_contact_links")
    .select(
      "contact_id, resource_name, etag, last_synced_at, photo_etag, google_photo_url, photo_push_attempts",
    )
    .eq("gmail_account_id", ids.gmailAccountId);
  const byLocal = new Map((links ?? []).map((l) => [l.contact_id, l]));

  // Two-pass dirty selection so photo-dirty contacts don't starve behind a
  // large body-dirty backlog. First pass targets links that need a photo
  // upload, including company/domain-logo fallbacks where avatar_url is null.
  // Second pass fills the remaining per-run budget with body-dirty rows,
  // oldest-updated first.
  const dirty: ContactRow[] = [];
  const seen = new Set<string>();
  const photoDirtyIds = (links ?? [])
    .filter((l) =>
      isGooglePhotoLinkDirty({
        photoEtag: l.photo_etag ?? null,
        photoPushAttempts: l.photo_push_attempts ?? 0,
      }),
    )
    .map((l) => l.contact_id);
  if (photoDirtyIds.length) {
    const { data: photoRows } = await supabaseAdmin
      .from("contacts")
      .select("id, email, updated_at, avatar_url, company_id")
      .eq("user_id", ids.userId)
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
      .select("id, email, updated_at, avatar_url, company_id")
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
  const pushStartedAt = Date.now();
  for (const c of contacts) {
    if (Date.now() - pushStartedAt > PUSH_WALL_BUDGET_MS) {
      logInfo("google_contacts.push.budget_exceeded", {
        ...ids,
        processed: count,
        remaining: contacts.length - count,
        budget_ms: PUSH_WALL_BUDGET_MS,
      });
      break;
    }
    const link = byLocal.get(c.id);
    const linkPhotoEtag = (link as { photo_etag?: string | null } | undefined)?.photo_etag ?? null;
    const linkGooglePhotoUrl =
      (link as { google_photo_url?: string | null } | undefined)?.google_photo_url ?? null;
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
      const memberResourceNames = withMyContacts(
        (memberships ?? [])
          .map((m) => groupResourceByLocal.get(m.group_id))
          .filter((n): n is string => !!n),
      );


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

      // Photo push: upload the effective local photo bytes to Google whenever
      // the resolver etag differs from the last one we pushed (`photo_etag`).
      // This includes contact portraits, uploaded company logos, and selected
      // company-domain logos. Runs after the person body update so the People
      // API has a fresh Person to attach the photo to. Failures leave
      // photo_etag untouched and bump photo_push_attempts; after
      // MAX_PHOTO_PUSH_ATTEMPTS we stop retrying and log a give-up alert.
      try {
        const previousUrl = linkPhotoEtag;
        const resource = link?.resource_name ?? createdResourceName;
        if (resource && linkPhotoAttempts < MAX_PHOTO_PUSH_ATTEMPTS) {
          const { resolveEffectiveContactPhotoForSync } =
            await import("@/lib/contacts/logo-photo.server");
          const photo = await resolveEffectiveContactPhotoForSync(ids.userId, c.id);
          if (!photo) {
            await supabaseAdmin
              .from("google_contact_links")
              .update({ photo_etag: NO_LOCAL_PHOTO_ETAG, photo_push_attempts: 0 })
              .eq("contact_id", c.id)
              .eq("gmail_account_id", ids.gmailAccountId);
            logInfo("google_contacts.push.photo_skipped_no_avatar", {
              ...ids,
              contact_id: c.id,
              company_id: c.company_id,
              avatar_url: currentAvatar,
              photo_etag: linkPhotoEtag,
              google_photo_url: linkGooglePhotoUrl,
            });
          }
          if (photo && photo.etag !== previousUrl) {
            const { updateContactPhoto } = await import("./people-client.server");
            try {
              await updateContactPhoto(ids.gmailAccountId, resource, photo.bytes);
              await supabaseAdmin
                .from("google_contact_links")
                .update({
                  photo_etag: photo.etag,
                  photo_push_attempts: 0,
                  last_photo_error: null,
                  last_photo_error_at: null,
                  last_photo_status: null,
                  last_photo_reason: null,
                })
                .eq("contact_id", c.id)
                .eq("gmail_account_id", ids.gmailAccountId);
              logInfo("google_contacts.push.photo_uploaded", {
                ...ids,
                contact_id: c.id,
                company_id: photo.companyId,
                avatar_url: photo.avatarUrl,
                company_logo_url: photo.companyLogoUrl,
                logo_domain: photo.domain,
                photo_source: photo.source,
                photo_etag: photo.etag,
                previous_photo_etag: linkPhotoEtag,
                google_photo_url: linkGooglePhotoUrl,
                bytes: photo.bytes.length,
              });
            } catch (uploadErr) {
              const nextAttempts = linkPhotoAttempts + 1;
              const status = uploadErr instanceof PeopleApiError ? uploadErr.status : undefined;
              const reason = uploadErr instanceof PeopleApiError ? uploadErr.googleReason : null;
              const message = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
              await supabaseAdmin
                .from("google_contact_links")
                .update({
                  photo_push_attempts: nextAttempts,
                  last_photo_error: message.slice(0, 500),
                  last_photo_error_at: new Date().toISOString(),
                  last_photo_status: typeof status === "number" ? status : null,
                  last_photo_reason: reason,
                })
                .eq("contact_id", c.id)
                .eq("gmail_account_id", ids.gmailAccountId);
              const payload = {
                ...ids,
                contact_id: c.id,
                company_id: photo.companyId,
                resource_name: resource,
                avatar_url: photo.avatarUrl,
                company_logo_url: photo.companyLogoUrl,
                logo_domain: photo.domain,
                photo_source: photo.source,
                photo_etag: linkPhotoEtag,
                resolved_photo_etag: photo.etag,
                google_photo_url: linkGooglePhotoUrl,
                attempts: nextAttempts,
                max_attempts: MAX_PHOTO_PUSH_ATTEMPTS,
                google_status: status ?? null,
                google_reason: reason,
                bytes: photo.bytes.length,
              };
              if (nextAttempts >= MAX_PHOTO_PUSH_ATTEMPTS) {
                logError("google_contacts.push.photo_gave_up", payload, uploadErr);
              } else {
                logError("google_contacts.push.photo_failed", payload, uploadErr);
              }
            }
          }
        }
      } catch (photoErr) {
        const status = photoErr instanceof PeopleApiError ? photoErr.status : undefined;
        const reason = photoErr instanceof PeopleApiError ? photoErr.googleReason : null;
        const message = photoErr instanceof Error ? photoErr.message : String(photoErr);
        await supabaseAdmin
          .from("google_contact_links")
          .update({
            last_photo_error: message.slice(0, 500),
            last_photo_error_at: new Date().toISOString(),
            last_photo_status: typeof status === "number" ? status : null,
            last_photo_reason: reason,
          })
          .eq("contact_id", c.id)
          .eq("gmail_account_id", ids.gmailAccountId);
        logError(
          "google_contacts.push.photo_failed",
          {
            ...ids,
            contact_id: c.id,
            company_id: c.company_id,
            avatar_url: currentAvatar,
            photo_etag: linkPhotoEtag,
            google_photo_url: linkGooglePhotoUrl,
            google_status: status ?? null,
            google_reason: reason,
          },
          photoErr,
        );
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
export async function pushGroupMemberships(
  ids: Ids,
  progress?: ProgressReporter,
): Promise<number> {
  const { data: links } = await supabaseAdmin
    .from("google_group_links")
    .select("contact_group_id, resource_name")
    .eq("gmail_account_id", ids.gmailAccountId);
  if (!links?.length) return 0;
  await progress?.set("pushing_memberships", 0, links.length);

  const { data: contactLinks } = await supabaseAdmin
    .from("google_contact_links")
    .select("contact_id, resource_name")
    .eq("gmail_account_id", ids.gmailAccountId);
  const contactResourceById = new Map(
    (contactLinks ?? []).map((l) => [l.contact_id, l.resource_name]),
  );

  let changedMemberships = 0;
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

    try {
      const remote = await getContactGroupWithMembers(ids.gmailAccountId, gl.resource_name);
      const { toAdd, toRemove } = calculateMembershipDelta({
        desiredResourceNames: desired,
        currentResourceNames: remote.memberResourceNames ?? [],
      });
      if (toAdd.length || toRemove.length) {
        await modifyGroupMembers(ids.gmailAccountId, gl.resource_name, toAdd, toRemove);
        changedMemberships += toAdd.length + toRemove.length;
        logInfo("google_contacts.push.membership_updated", {
          ...ids,
          contact_group_id: gl.contact_group_id,
          resource_name: gl.resource_name,
          added: toAdd.length,
          removed: toRemove.length,
        });
      }
    } catch (e) {
      logError(
        "google_contacts.push.membership_failed",
        { ...ids, contact_group_id: gl.contact_group_id, resource_name: gl.resource_name },
        e,
      );
    }
    await progress?.increment(1);
  }
  return changedMemberships;
}
