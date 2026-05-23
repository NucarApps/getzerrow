// Gmail Pub/Sub push webhook. Logs every incoming envelope (including the
// decoded payload and Pub/Sub message metadata) so the Settings activity
// panel can show exactly why a push didn't lead to a sync.
//
// Synthetic test requests from the app's "Test webhook" buttons set the
// `x-zerrow-test: 1` header so they are logged as `webhook_test` instead
// of `push` / `push_empty` and do NOT pollute real Google push diagnostics.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncSinceHistory } from "@/lib/sync.server";
import { verifyGoogleJwt } from "@/lib/google-jwt.server";

export const Route = createFileRoute("/api/public/gmail-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const isTest = request.headers.get("x-zerrow-test") === "1";

        // Authenticate Pub/Sub push. Preferred: OIDC bearer JWT signed by
        // Google (set on the subscription via pushConfig.oidcToken). Fallback:
        // legacy `?token=` shared secret. Test calls from the app are exempt.
        let authMode: "jwt" | "legacy_token" | "none" = "none";
        if (!isTest) {
          const url = new URL(request.url);
          const authHeader = request.headers.get("authorization");
          const bearer = authHeader?.toLowerCase().startsWith("bearer ")
            ? authHeader.slice(7).trim()
            : null;

          if (bearer) {
            // Accept any of: webhook URL (with or without query) as audience.
            // Optional GMAIL_PUBSUB_SERVICE_ACCOUNT pins the signer's email.
            const audiences = [
              `${url.origin}${url.pathname}`,
              `${url.origin}${url.pathname}${url.search}`,
            ];
            const expectedEmail = process.env.GMAIL_PUBSUB_SERVICE_ACCOUNT || undefined;
            const result = await verifyGoogleJwt(bearer, { audiences, expectedEmail });
            if (result.ok) {
              authMode = "jwt";
            } else {
              try {
                await supabaseAdmin.from("pubsub_events").insert({
                  event_type: "push_unauthorized",
                  subscription: `${url.pathname}${url.search}`,
                  details: `OIDC verify failed: ${result.reason}`,
                });
              } catch (logErr) {
                console.error("pubsub_events unauthorized log failed", logErr);
              }
              return new Response("Unauthorized", { status: 401 });
            }
          } else {
            // Legacy fallback — single shared secret in ?token=. Removed once
            // every subscription is migrated to OIDC.
            const expected = process.env.GMAIL_WEBHOOK_TOKEN;
            const provided = url.searchParams.get("token");
            if (!expected || provided !== expected) {
              const fp = (s: string | null | undefined) =>
                s ? `${s.slice(0, 2)}…${s.slice(-2)}` : "(none)";
              let details: string;
              if (!expected) {
                details = "Server missing GMAIL_WEBHOOK_TOKEN secret and no OIDC bearer";
              } else if (!provided) {
                details = `No Authorization bearer and no ?token= query param (expected length ${expected.length}, fp ${fp(expected)})`;
              } else {
                details = `Token mismatch (provided length ${provided.length} fp ${fp(provided)}, expected length ${expected.length} fp ${fp(expected)})`;
              }
              try {
                await supabaseAdmin.from("pubsub_events").insert({
                  event_type: "push_unauthorized",
                  subscription: `${url.pathname}${url.search}`,
                  details,
                });
              } catch (logErr) {
                console.error("pubsub_events unauthorized log failed", logErr);
              }
              return new Response("Unauthorized", { status: 401 });
            }
            authMode = "legacy_token";
            // Log so we can see which subscriptions still need OIDC migration.
            try {
              await supabaseAdmin.from("pubsub_events").insert({
                event_type: "push_legacy_auth",
                subscription: `${url.pathname}${url.search}`,
                details: "Authenticated via legacy ?token= — migrate subscription to OIDC",
              });
            } catch (logErr) {
              console.error("pubsub_events legacy log failed", logErr);
            }
          }
        }
        // Suppress unused-var lint while still capturing for future telemetry.
        void authMode;
        let emailAddress: string | null = null;
        let historyId: string | null = null;
        let accountsMatched = 0;
        let enqueuedCount = 0;
        let errorMsg: string | null = null;
        let messageId: string | null = null;
        let publishTime: string | null = null;
        let subscription: string | null = null;
        let payload: unknown = null;
        let details: string | null = null;
        let hadData = false;
        try {
          const body = await request.json();
          messageId = body?.message?.messageId ?? body?.message?.message_id ?? null;

          // Dedupe: Pub/Sub redelivers on slow ack. If we've already logged
          // a `push` for this messageId within the last 60s, skip processing
          // and just log a `push_duplicate` row for visibility.
          if (messageId && !isTest) {
            const { data: dup } = await supabaseAdmin
              .from("pubsub_events")
              .select("id")
              .eq("message_id", messageId)
              .eq("event_type", "push")
              .gte("received_at", new Date(Date.now() - 60_000).toISOString())
              .limit(1)
              .maybeSingle();
            if (dup) {
              try {
                await supabaseAdmin.from("pubsub_events").insert({
                  event_type: "push_duplicate",
                  message_id: messageId,
                  details: `Duplicate Pub/Sub delivery within 60s (original ${dup.id})`,
                });
              } catch (logErr) {
                console.error("pubsub_events duplicate log failed", logErr);
              }
              return new Response("ok (duplicate)", { status: 200 });
            }
          }
          publishTime = body?.message?.publishTime ?? body?.message?.publish_time ?? null;
          subscription = body?.subscription ?? null;
          const dataB64 = body?.message?.data;
          if (!dataB64) {
            details = "Pub/Sub envelope had no message.data field";
            payload = body ?? null;
          } else {
            hadData = true;
            try {
              payload = JSON.parse(Buffer.from(dataB64, "base64").toString("utf-8"));
            } catch (decodeErr) {
              details = `Failed to decode message.data: ${(decodeErr as Error).message}`;
              payload = { raw: dataB64 };
            }
            const decoded = (payload ?? {}) as { emailAddress?: string; historyId?: number | string };
            emailAddress = decoded.emailAddress ?? null;
            historyId = decoded.historyId != null ? String(decoded.historyId) : null;

            if (!emailAddress) {
              details = details ?? "Decoded payload had no emailAddress field";
            } else {
              const { data: accounts } = await supabaseAdmin
                .from("gmail_accounts")
                .select("id, email_address")
                .eq("email_address", emailAddress);
              accountsMatched = accounts?.length ?? 0;
              if (accountsMatched === 0) {
                details = `No gmail_accounts row matches "${emailAddress}" — watch was probably created against a different connected account.`;
              }
              for (const acc of accounts ?? []) {
                try {
                  const r = await syncSinceHistory(acc.id);
                  if (r && typeof (r as { synced?: number }).synced === "number") {
                    enqueuedCount += (r as { synced: number }).synced;
                  }
                } catch (e) {
                  console.error("sync failed for", acc.id, e);
                  errorMsg = (e as Error)?.message ?? String(e);
                }
              }
              // Note: we intentionally do NOT drain message_jobs inline here.
              // Pub/Sub requires fast 200 responses (slow webhooks → Google
              // retries → duplicate work). The dedicated 5s `gmail-process-
              // live-5s` cron already owns the priority=0 lane and drains
              // newly-enqueued live mail within seconds.
            }
          }
        } catch (e: unknown) {
          const err = e as Error;
          console.error("webhook error", err);
          errorMsg = err?.message ?? String(e);
        } finally {
          try {
            // Single row per request. Synthetic tests are tagged so they
            // can be filtered out of real push stats.
            const event_type = isTest
              ? "webhook_test"
              : hadData
              ? "push"
              : "push_empty";
            await supabaseAdmin.from("pubsub_events").insert({
              event_type,
              email_address: emailAddress,
              history_id: historyId,
              accounts_matched: hadData ? accountsMatched : null,
              synced_count: hadData ? enqueuedCount : null,
              error: errorMsg,
              message_id: messageId,
              publish_time: publishTime,
              subscription,
              payload: (payload ?? null) as never,
              details: isTest
                ? `App-side webhook test — ${details ?? (hadData && accountsMatched > 0 ? "matched account and ran sync" : "synthetic envelope")}`
                : details,
            });
          } catch (logErr) {
            console.error("pubsub_events log failed", logErr);
          }
        }
        return new Response("ok", { status: 200 });
      },
    },
  },
});
