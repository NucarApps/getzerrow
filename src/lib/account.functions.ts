import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { stopWatch } from "./gmail.server";
import { revokeGoogleOAuthForAccount } from "./google-oauth.server";
import { logError, logAudit } from "./log.server";

/**
 * Permanently delete the authenticated user's account and all data we hold
 * about them. Revokes Google OAuth grants at Google, deletes per-user rows
 * across every table that stores user data, then deletes the auth user.
 *
 * This is irreversible.
 */
export const deleteAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = context.userId;

    // 1. Revoke Google OAuth + stop Pub/Sub watches for every connected Gmail account.
    const { data: accounts } = await supabaseAdmin
      .from("gmail_accounts")
      .select("id, email_address")
      .eq("user_id", userId);
    const emailAddresses = (accounts ?? [])
      .map((a) => a.email_address)
      .filter((e): e is string => typeof e === "string" && e.length > 0);
    for (const acc of accounts ?? []) {
      try { await stopWatch(acc.id); } catch (e) { logError("account.delete.stop_watch_failed", { user_id: userId, account_id: acc.id }, e); }
      try { await revokeGoogleOAuthForAccount(acc.id); } catch (e) { logError("account.delete.revoke_failed", { user_id: userId, account_id: acc.id }, e); }
    }

    // 2. Tables NOT keyed by user_id need their own predicate, or the delete
    //    silently no-ops (the column doesn't exist) and leaves PII behind:
    //      folder_filters → keyed by folder_id (delete via the user's folders)
    //      card_events    → keyed by owner_user_id
    //    Privacy policy promises "filters" are removed, so this must run.
    // Count delete failures so the audit trail can flag a partial erasure.
    let deleteErrors = 0;
    const { data: userFolders } = await supabaseAdmin
      .from("folders")
      .select("id")
      .eq("user_id", userId);
    const folderIds = (userFolders ?? []).map((f) => f.id);
    if (folderIds.length > 0) {
      const { error: ffErr } = await supabaseAdmin
        .from("folder_filters")
        .delete()
        .in("folder_id", folderIds);
      if (ffErr) { deleteErrors++; logError("account.delete.table_failed", { user_id: userId, table: "folder_filters" }, ffErr); }
    }
    {
      const { error: ceErr } = await supabaseAdmin
        .from("card_events")
        .delete()
        .eq("owner_user_id", userId);
      if (ceErr) { deleteErrors++; logError("account.delete.table_failed", { user_id: userId, table: "card_events" }, ceErr); }
    }

    // 2b. Delete all per-user rows. Order matters only where one table
    //    references another by uuid in app code — RLS already scopes
    //    everything to user_id, and there are no FKs to cascade.
    const tables = [
      "reply_drafts",
      "folder_examples",
      "folder_summary_jobs",
      "folder_summary_schedules",
      "message_jobs",
      "backfill_jobs",
      "email_search_index",
      "emails",
      "folders",
      "inbox_override_exceptions",
      "inbox_overrides",
      "contacts",
      "contact_phones",
      "contact_groups",
      "contact_group_members",
      "contact_cards_sent",
      "company_aliases",
      "company_group_assignments",
      "company_logo_choices",
      "my_cards",
      "sync_state",
      "game_scores",
      "calendar_contacts",
      "gmail_accounts",
    ] as const;

    for (const table of tables) {
      const { error } = await (supabaseAdmin.from(table) as unknown as {
        delete: () => { eq: (col: string, val: string) => Promise<{ error: { message: string } | null }> };
      }).delete().eq("user_id", userId);
      if (error) {
        deleteErrors++;
        logError("account.delete.table_failed", { user_id: userId, table }, error);
      }
    }

    // 2c. pubsub_events has no user_id — it's keyed by the Gmail address from
    //     the push notification. Delete rows for every address we just removed.
    if (emailAddresses.length > 0) {
      const { error: pubsubErr } = await supabaseAdmin
        .from("pubsub_events")
        .delete()
        .in("email_address", emailAddresses);
      if (pubsubErr) {
        deleteErrors++;
        logError("account.delete.table_failed", { user_id: userId, table: "pubsub_events" }, pubsubErr);
      }
    }


    // 3. Delete the auth user. After this the JWT is dead.
    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (authErr) {
      logError("account.delete.auth_failed", { user_id: userId }, authErr);
      throw new Error(`Failed to delete account: ${authErr.message}`);
    }

    // Audit: full account + all restricted Google data erased at user request.
    // delete_errors>0 means some per-table deletes failed (logged above) — the
    // erasure was partial and needs follow-up.
    logAudit("account.deleted", {
      user_id: userId,
      gmail_accounts: accounts?.length ?? 0,
      delete_errors: deleteErrors,
    });

    return { ok: true };
  });
