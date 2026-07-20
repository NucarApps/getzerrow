// Orchestrator for Google Contacts two-way sync: pull → push → cursor bump.
// Called by the cron tick and the "Sync now" server fn.
import { logInfo, logError } from "@/lib/log.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { pullFromGoogle } from "./pull.server";
import { pushToGoogle } from "./push.server";
import { ensureSyncState, updateSyncState, loadSyncState } from "./state.server";
import { CONTACTS_SCOPE, PeopleApiError } from "./people-client.server";
import { NeedsReconnectError } from "@/lib/google-oauth.server";
import { createProgressReporter } from "./progress.server";

/** True when the account has actually granted the People API scope. */
export function accountHasContactsScope(scopeString: string | null | undefined): boolean {
  return (scopeString ?? "").split(/\s+/).includes(CONTACTS_SCOPE);
}

// Stale-lease window. A pull+push run now finishes under PUSH_WALL_BUDGET_MS
// (~18s) plus a small pull, so a healthy run is done well inside 30s. If a
// row's `locked_at` is older than this window, the previous worker was killed
// before finalize (Safari fetch abort, worker CPU cap) — safe to reclaim so
// the next click isn't rejected with "locked" and stuck at the previous
// progress count.
const LEASE_STALE_MS = 30_000;

/** Clear stored photo tags for linked contacts that have no local avatar,
 * so the next pull refetches the Google photo. Runs opportunistically on
 * every sync — the pull loop only downloads bytes for rows whose etag was
 * actually cleared, so this is safe to repeat. Exported so the CardDAV
 * dispatch can trigger it right after an iPhone sync completes. */
export async function autoClearMissingPhotoEtags(
  userId: string,
  gmailAccountId: string,
): Promise<void> {
  try {
    const { data: links } = await supabaseAdmin
      .from("google_contact_links")
      .select("contact_id, contacts!inner(avatar_url)")
      .eq("user_id", userId)
      .eq("gmail_account_id", gmailAccountId)
      .not("google_photo_url", "is", null)
      .is("contacts.avatar_url", null)
      .limit(500);
    const ids = (links ?? [])
      .map((l) => (l as { contact_id?: string }).contact_id)
      .filter((v): v is string => !!v);
    if (ids.length === 0) return;
    await supabaseAdmin
      .from("google_contact_links")
      .update({ google_photo_url: null })
      .eq("gmail_account_id", gmailAccountId)
      .in("contact_id", ids);
    logInfo("google_contacts.photo_backfill.cleared", {
      userId,
      gmailAccountId,
      count: ids.length,
    });
  } catch (e) {
    // Non-fatal: the sync should proceed even if this optimization fails.
    logError("google_contacts.photo_backfill.failed", { userId, gmailAccountId }, e);
  }
}

export async function runGoogleContactsSync(
  userId: string,
  gmailAccountId: string,
): Promise<{ ok: boolean; pull?: number; push?: number; error?: string }> {
  const runId = crypto.randomUUID();
  const ids = { userId, gmailAccountId, runId };

  const state = await ensureSyncState(userId, gmailAccountId);
  const mode = state.sync_mode ?? (state.enabled ? "two_way" : "off");
  if (mode === "off" || !state.enabled) return { ok: false, error: "sync_disabled" };
  const pullOnly = mode === "pull_only";

  const now = new Date();
  if (state.locked_at) {
    const age = now.getTime() - new Date(state.locked_at).getTime();
    if (age < LEASE_STALE_MS) {
      logInfo("google_contacts.run.skipped_lease", { ...ids });
      return { ok: false, error: "locked" };
    }
  }
  await updateSyncState(state.id, { locked_at: now.toISOString() });
  const progress = createProgressReporter(state.id);
  await progress.set("starting", 0, 0);

  // Always release the lease, even if the pull/push block throws in a place
  // that skips the catch (e.g. a synchronous error inside a helper, or a
  // secondary throw from the catch itself). Success/failure results return
  // from try/catch; finally only guarantees the unlock.
  try {
    // Short-circuit if the account is flagged for reconnect. The People API
    // itself returns 403 (isMissingScope) when the contacts scope is absent,
    // which we translate to `missing_contacts_scope` in the catch below.
    const { data: acct } = await supabaseAdmin
      .from("gmail_accounts")
      .select("needs_reconnect")
      .eq("id", gmailAccountId)
      .maybeSingle();
    if (acct?.needs_reconnect) {
      await updateSyncState(state.id, { last_error: "needs_reconnect" });
      return { ok: false, error: "needs_reconnect" };
    }

    // Auto-backfill missing photos: clear photo_etag for any linked contact
    // whose local avatar is still empty, so this run's pull refetches the
    // Google photo. Covers contacts that were linked before photo sync
    // shipped and cases where a prior download failed. Cheap: one indexed
    // UPDATE, and the pull loop only downloads bytes for the cleared rows.
    await autoClearMissingPhotoEtags(userId, gmailAccountId);

    const pull = await pullFromGoogle(ids, progress);
    const push = pullOnly
      ? { contactsPushed: 0, groupsPushed: 0 }
      : await pushToGoogle(ids, progress);
    await progress.set("finalizing", 0, 0);

    await updateSyncState(state.id, {
      people_sync_token: pull.peopleSyncToken ?? state.people_sync_token,
      groups_sync_token: pull.groupsSyncToken ?? state.groups_sync_token,
      last_full_sync_at: pull.usedFullResync ? now.toISOString() : state.last_full_sync_at,
      last_incremental_at: now.toISOString(),
      last_pull_count: pull.pulled,
      last_push_count: push.contactsPushed + push.groupsPushed,
      last_pull_created: pull.breakdown.created,
      last_pull_updated: pull.breakdown.updated,
      last_pull_skipped_no_email: pull.breakdown.skipped_no_email,
      last_pull_merged: pull.breakdown.merged_duplicate_email + pull.breakdown.merged_by_phone,
      last_pull_failed: pull.breakdown.failed,
      last_error: null,
      pending_bump: false,
    });
    return { ok: true, pull: pull.pulled, push: push.contactsPushed + push.groupsPushed };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    logError("google_contacts.run.failed", { ...ids }, e);
    let errorKey = msg.slice(0, 400);
    if (e instanceof NeedsReconnectError) errorKey = "needs_reconnect";
    else if (e instanceof PeopleApiError && e.isMissingScope) errorKey = "missing_contacts_scope";
    await updateSyncState(state.id, { last_error: errorKey });
    return { ok: false, error: errorKey };
  } finally {
    // Belt-and-suspenders: clear the lease + progress regardless of what
    // happened above. Swallow errors here — the caller already has its
    // result and a stuck lease will still be reclaimed by the next run's
    // stale-lease check.
    try {
      await progress.clear();
    } catch {
      // ignore
    }
    try {
      await updateSyncState(state.id, { locked_at: null });
    } catch (unlockErr) {
      logError("google_contacts.run.unlock_failed", { ...ids }, unlockErr);
    }
  }
}

/** Read-only summary for the settings UI. */
export async function getGoogleContactsStatus(userId: string, gmailAccountId: string) {
  const state = await loadSyncState(userId, gmailAccountId);
  const { data: acct } = await supabaseAdmin
    .from("gmail_accounts")
    .select("needs_reconnect, email_address, contacts_access")
    .eq("id", gmailAccountId)
    .maybeSingle();
  return {
    state,
    email: acct?.email_address ?? null,
    // Reflects the scopes granted on the last OAuth consent. The People API
    // call is still the source of truth at sync time, but this lets the UI
    // show an accurate banner immediately after reconnect.
    scope_granted: acct ? !!acct.contacts_access : (null as boolean | null),
    needs_reconnect: !!acct?.needs_reconnect,
  };
}
