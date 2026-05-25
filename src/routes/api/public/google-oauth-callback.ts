// Per-user Google OAuth callback. Verifies signed state, exchanges code,
// stores tokens, starts Gmail push watch, redirects back to settings.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  exchangeCode,
  fetchUserEmail,
  getRedirectUri,
  verifyState,
} from "@/lib/google-oauth.server";
import { ensureWatch } from "@/lib/gmail.server";

export const Route = createFileRoute("/api/public/google-oauth-callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
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

          // Goes through upsert_gmail_oauth_account so the tokens are
          // encrypted with pgsodium before they touch the table. Falls
          // back to a direct upsert if the migration hasn't been
          // applied yet — keeps OAuth working during the deploy window
          // between code landing and migrations running.
          type UpsertRpc = { rpc: (fn: "upsert_gmail_oauth_account", args: {
            p_user_id: string;
            p_email_address: string;
            p_access_token: string;
            p_refresh_token: string;
            p_token_expires_at: string;
          }) => Promise<{ data: string | null; error: { message: string } | null }> };
          let accountId: string | null = null;
          let upsertError: string | null = null;
          {
            const r = await (supabaseAdmin as unknown as UpsertRpc).rpc(
              "upsert_gmail_oauth_account",
              {
                p_user_id: userId,
                p_email_address: email,
                p_access_token: tokens.access_token,
                p_refresh_token: tokens.refresh_token,
                p_token_expires_at: expiresAt,
              },
            );
            if (r.error) {
              const m = r.error.message;
              const missing = m.includes("Could not find the function") || m.includes("schema cache") || m.includes("does not exist");
              if (!missing) {
                upsertError = m;
              } else {
                console.warn("upsert_gmail_oauth_account RPC missing — falling back to direct upsert");
                const fb = await supabaseAdmin
                  .from("gmail_accounts")
                  .upsert(
                    {
                      user_id: userId,
                      email_address: email,
                      access_token: tokens.access_token,
                      refresh_token: tokens.refresh_token,
                      token_expires_at: expiresAt,
                    },
                    { onConflict: "user_id,email_address" },
                  )
                  .select("id")
                  .single();
                if (fb.error || !fb.data) upsertError = fb.error?.message ?? "no row returned";
                else accountId = fb.data.id;
              }
            } else {
              accountId = r.data;
            }
          }

          if (!accountId) {
            console.error("oauth: failed to save account", upsertError);
            return new Response("Something went wrong saving your account. Please try again.", { status: 500 });
          }
          const account = { id: accountId };

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
