import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { stopWatch } from "./gmail.server";
import { revokeGoogleOAuthForAccount } from "./google-oauth.server";
import { logError } from "./log.server";

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
      .select("id")
      .eq("user_id", userId);
    for (const acc of accounts ?? []) {
      try { await stopWatch(acc.id); } catch (e) { logError("account.delete.stop_watch_failed", { user_id: userId, account_id: acc.id }, e); }
      try { await revokeGoogleOAuthForAccount(acc.id); } catch (e) { logError("account.delete.revoke_failed", { user_id: userId, account_id: acc.id }, e); }
    }

    // 2. Delete all per-user rows. Order matters only where one table
    //    references another by uuid in app code — RLS already scopes
    //    everything to user_id, and there are no FKs to cascade.
    const tables = [
      "reply_drafts",
      "folder_examples",
      "folder_filters",
      "folder_summary_jobs",
      "folder_summary_schedules",
      "message_jobs",
      "backfill_jobs",
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
      "card_events",
      "my_cards",
      "sync_state",
      "game_scores",
      "gmail_accounts",
    ] as const;

    for (const table of tables) {
      const { error } = await (supabaseAdmin.from(table) as unknown as {
        delete: () => { eq: (col: string, val: string) => Promise<{ error: { message: string } | null }> };
      }).delete().eq("user_id", userId);
      if (error) {
        logError("account.delete.table_failed", { user_id: userId, table }, error);
      }
    }

    // 3. Delete the auth user. After this the JWT is dead.
    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (authErr) {
      logError("account.delete.auth_failed", { user_id: userId }, authErr);
      throw new Error(`Failed to delete account: ${authErr.message}`);
    }

    return { ok: true };
  });
