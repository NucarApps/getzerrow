// Per-user Google OAuth callback. Verifies signed state, exchanges code,
// stores tokens, starts Gmail push watch, redirects back to settings.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  exchangeCode,
  fetchUserEmail,
  getRedirectUri,
  verifyState,
  clearNeedsReconnect,
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
          return redirect({ to: "/settings", search: { error: errParam } } as any);
        }
        if (!code || !state) {
          return new Response("Missing code or state", { status: 400 });
        }

        let userId: string;
        try {
          userId = verifyState(state);
        } catch (e: any) {
          console.error("oauth: invalid state", e);
          return new Response("Invalid or expired authorization state. Please try connecting again.", { status: 400 });
        }

        try {
          const redirectUri = getRedirectUri(origin);
          const tokens = await exchangeCode(code, redirectUri);
          if (!tokens.refresh_token) {
            return new Response(
              "Google did not return a refresh token. Please remove the app from your Google Account permissions (myaccount.google.com/permissions) and try again.",
              { status: 400 }
            );
          }
          const email = await fetchUserEmail(tokens.access_token);
          const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

          // Tokens are encrypted at rest via pgcrypto inside the RPC; the
          // key is held server-side and passed per-call.
          const encKey = process.env.EMAIL_ENC_KEY;
          if (!encKey) {
            console.error("oauth: EMAIL_ENC_KEY not configured");
            return new Response("Server misconfigured. Please contact support.", { status: 500 });
          }
          type UpsertRpc = { rpc: (fn: "upsert_gmail_oauth_account", args: {
            p_user_id: string;
            p_email_address: string;
            p_access_token: string;
            p_refresh_token: string;
            p_token_expires_at: string;
            p_key: string;
          }) => Promise<{ data: string | null; error: { message: string } | null }> };
          const { data: accountId, error } = await (supabaseAdmin as unknown as UpsertRpc).rpc(
            "upsert_gmail_oauth_account",
            {
              p_user_id: userId,
              p_email_address: email,
              p_access_token: tokens.access_token,
              p_refresh_token: tokens.refresh_token,
              p_token_expires_at: expiresAt,
              p_key: encKey,
            },
          );

          if (error || !accountId) {
            console.error("oauth: failed to save account", error);
            return new Response("Something went wrong saving your account. Please try again.", { status: 500 });
          }
          const account = { id: accountId };

          // Successful (re)auth: clear any prior reconnect flag/error.
          await clearNeedsReconnect(account.id);


          // Start Gmail push watch if topic is configured
          try {
            const watch = await ensureWatch(account.id, null);
            if (watch) {
              await supabaseAdmin.from("gmail_accounts").update({
                history_id: watch.historyId,
                watch_expiration: new Date(parseInt(watch.expiration, 10)).toISOString(),
              }).eq("id", account.id);
            }
          } catch (e) {
            console.error("ensureWatch failed during connect", e);
          }

          return new Response(null, { status: 302, headers: { Location: "/settings?connected=1" } });
        } catch (e: any) {
          console.error("oauth callback failed", e);
          return new Response("Something went wrong completing sign-in. Please try again.", { status: 500 });
        }
      },
    },
  },
});
