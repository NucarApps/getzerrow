// Orchestrator for Google Contacts two-way sync: pull → push → cursor bump.
// Called by the cron tick and the "Sync now" server fn.
import { logInfo, logError } from "@/lib/log.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { pullFromGoogle } from "./pull.server";
import { pushToGoogle } from "./push.server";
import { ensureSyncState, updateSyncState, loadSyncState } from "./state.server";
import { CONTACTS_SCOPE, PeopleApiError } from "./people-client.server";
import { NeedsReconnectError } from "@/lib/google-oauth.server";

/** True when the account has actually granted the People API scope. */
export function accountHasContactsScope(scopeString: string | null | undefined): boolean {
  return (scopeString ?? "").split(/\s+/).includes(CONTACTS_SCOPE);
}

export async function runGoogleContactsSync(
  userId: string,
  gmailAccountId: string,
): Promise<{ ok: boolean; pull?: number; push?: number; error?: string }> {
  const runId = crypto.randomUUID();
  const ids = { userId, gmailAccountId, runId };

  const state = await ensureSyncState(userId, gmailAccountId);
  if (!state.enabled) return { ok: false, error: "sync_disabled" };

  // Simple in-DB lease: skip if another run picked it up in the last 5 min.
  const now = new Date();
  if (state.locked_at) {
    const age = now.getTime() - new Date(state.locked_at).getTime();
    if (age < 5 * 60 * 1000) {
      logInfo("google_contacts.run.skipped_lease", { ...ids });
      return { ok: false, error: "locked" };
    }
  }
  await updateSyncState(state.id, { locked_at: now.toISOString() });

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
      await updateSyncState(state.id, {
        last_error: "needs_reconnect",
        locked_at: null,
      });
      return { ok: false, error: "needs_reconnect" };
    }

    const pull = await pullFromGoogle(ids);
    const push = await pushToGoogle(ids);

    await updateSyncState(state.id, {
      people_sync_token: pull.peopleSyncToken ?? state.people_sync_token,
      groups_sync_token: pull.groupsSyncToken ?? state.groups_sync_token,
      last_full_sync_at: pull.usedFullResync ? now.toISOString() : state.last_full_sync_at,
      last_incremental_at: now.toISOString(),
      last_pull_count: pull.pulled,
      last_push_count: push.contactsPushed + push.groupsPushed,
      last_error: null,
      pending_bump: false,
      locked_at: null,
    });
    return { ok: true, pull: pull.pulled, push: push.contactsPushed + push.groupsPushed };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    logError("google_contacts.run.failed", { ...ids }, e);
    let errorKey = msg.slice(0, 400);
    if (e instanceof NeedsReconnectError) errorKey = "needs_reconnect";
    else if (e instanceof PeopleApiError && e.isMissingScope) errorKey = "missing_contacts_scope";
    await updateSyncState(state.id, {
      last_error: errorKey,
      locked_at: null,
    });
    return { ok: false, error: errorKey };
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
