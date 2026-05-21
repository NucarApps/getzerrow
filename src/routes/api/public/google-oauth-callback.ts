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

          const { data: account, error } = await supabaseAdmin
            .from("gmail_accounts")
            .upsert(
              {
                user_id: userId,
                email_address: email,
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                token_expires_at: expiresAt,
              },
              { onConflict: "user_id,email_address" }
            )
            .select("id")
            .single();

          if (error || !account) {
            return new Response(`Failed to save account: ${error?.message}`, { status: 500 });
          }

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
          return new Response(`OAuth failed: ${e.message}`, { status: 500 });
        }
      },
    },
  },
});
