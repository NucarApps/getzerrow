// Per-user Google OAuth callback. Verifies signed state, exchanges code,
// stores tokens, starts Gmail push watch, redirects back to settings.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  exchangeCode,
  fetchUserEmail,
  getRedirectUri,
  verifyState,
  clearNeedsReconnect,
  scopeGrantsCalendar,
  scopeGrantsContacts,
} from "@/lib/google-oauth.server";
import { ensureWatch } from "@/lib/gmail.server";
import { logError, newRunId } from "@/lib/log.server";

export const Route = createFileRoute("/api/public/google-oauth-callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const runId = newRunId();
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const errParam = url.searchParams.get("error");
        const origin = `${url.protocol}//${url.host}`;

        if (errParam) {
          return new Response(null, {
            status: 302,
            headers: { Location: `/settings?error=${encodeURIComponent(errParam)}` },
          });
        }
        if (!code || !state) {
          return new Response("Missing code or state", { status: 400 });
        }

        let userId: string;
        try {
          userId = await verifyState(state);
        } catch (e: unknown) {
          logError("oauth.invalid_state", { run_id: runId }, e);
          return new Response(
            "Invalid or expired authorization state. Please try connecting again.",
            { status: 400 },
          );
        }

        try {
          const redirectUri = getRedirectUri(origin);
          const tokens = await exchangeCode(code, redirectUri);
          if (!tokens.refresh_token) {
            return new Response(
              "Google did not return a refresh token. Please remove the app from your Google Account permissions (myaccount.google.com/permissions) and try again.",
              { status: 400 },
            );
          }
          const email = await fetchUserEmail(tokens.access_token);
          const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

          // Tokens are encrypted at rest via pgcrypto inside the RPC; the
          // key is held server-side and passed per-call.
          const encKey = process.env.EMAIL_ENC_KEY;
          if (!encKey) {
            logError("oauth.misconfigured", {
              run_id: runId,
              user_id: userId,
              reason: "EMAIL_ENC_KEY not configured",
            });
            return new Response("Server misconfigured. Please contact support.", { status: 500 });
          }
          type UpsertRpc = {
            rpc: (
              fn: "upsert_gmail_oauth_account",
              args: {
                p_user_id: string;
                p_email_address: string;
                p_access_token: string;
                p_refresh_token: string;
                p_token_expires_at: string;
                p_key: string;
              },
            ) => Promise<{ data: string | null; error: { message: string } | null }>;
          };
          const { data: accountId, error } = await (supabaseAdmin as unknown as UpsertRpc).rpc(
            "upsert_gmail_oauth_account",
            {
              p_user_id: userId,
              p_email_address: email.toLowerCase(),
              p_access_token: tokens.access_token,
              p_refresh_token: tokens.refresh_token,
              p_token_expires_at: expiresAt,
              p_key: encKey,
            },
          );

          if (error || !accountId) {
            logError(
              "oauth.save_account_failed",
              { run_id: runId, user_id: userId, email_address: email },
              error,
            );
            return new Response("Something went wrong saving your account. Please try again.", {
              status: 500,
            });
          }
          const account = { id: accountId };

          // Successful (re)auth: clear any prior reconnect flag/error.
          await clearNeedsReconnect(account.id);

          // Record whether the user granted Calendar read access so the
          // calendar cold-email guard can run (and the UI can prompt a
          // reconnect when it's missing).
          try {
            const hasContacts = scopeGrantsContacts(tokens.scope);
            await supabaseAdmin
              .from("gmail_accounts")
              .update({
                calendar_access: scopeGrantsCalendar(tokens.scope),
                contacts_access: hasContacts,
              })
              .eq("id", account.id);

            // Sync the contacts sync-state error flag with the freshly granted
            // scopes so the settings banner reflects reality immediately,
            // instead of waiting for the next reconcile to clear (or re-set)
            // a stale `missing_contacts_scope` value.
            if (hasContacts) {
              await supabaseAdmin
                .from("google_sync_state")
                .update({ last_error: null })
                .eq("user_id", userId)
                .eq("gmail_account_id", account.id)
                .in("last_error", ["missing_contacts_scope", "needs_reconnect"]);
            } else {
              await supabaseAdmin
                .from("google_sync_state")
                .update({ last_error: "missing_contacts_scope" })
                .eq("user_id", userId)
                .eq("gmail_account_id", account.id);
            }
          } catch (e) {
            logError(
              "oauth.scope_access_update_failed",
              { run_id: runId, account_id: account.id, user_id: userId },
              e,
            );
          }

          // Start Gmail push watch if topic is configured
          try {
            const watch = await ensureWatch(account.id, null);
            if (watch) {
              await supabaseAdmin
                .from("gmail_accounts")
                .update({
                  history_id: watch.historyId,
                  watch_expiration: new Date(parseInt(watch.expiration, 10)).toISOString(),
                })
                .eq("id", account.id);
            }
          } catch (e) {
            logError(
              "oauth.ensure_watch_failed",
              { run_id: runId, account_id: account.id, user_id: userId },
              e,
            );
          }

          return new Response(null, {
            status: 302,
            headers: { Location: "/settings?connected=1" },
          });
        } catch (e: unknown) {
          logError("oauth.callback_failed", { run_id: runId, user_id: userId }, e);
          return new Response("Something went wrong completing sign-in. Please try again.", {
            status: 500,
          });
        }
      },
    },
  },
});
