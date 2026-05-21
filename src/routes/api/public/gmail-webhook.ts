// Gmail Pub/Sub push webhook. Logs every incoming envelope (including the
// decoded payload and Pub/Sub message metadata) so the Settings activity
// panel can show exactly why a push didn't lead to a sync.
//
// Synthetic test requests from the app's "Test webhook" buttons set the
// `x-zerrow-test: 1` header so they are logged as `webhook_test` instead
// of `push` / `push_empty` and do NOT pollute real Google push diagnostics.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncSinceHistory, runMessageJobs } from "@/lib/sync.server";

export const Route = createFileRoute("/api/public/gmail-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const isTest = request.headers.get("x-zerrow-test") === "1";
        // Verify Pub/Sub push token (configure on the subscription's push endpoint
        // as ?token=<GMAIL_WEBHOOK_TOKEN>). Test calls from the app are exempt.
        if (!isTest) {
          const expected = process.env.GMAIL_WEBHOOK_TOKEN;
          const url = new URL(request.url);
          const provided = url.searchParams.get("token");
          if (!expected || provided !== expected) {
            // Log a diagnostic row so misconfigured Pub/Sub pushes are visible
            // in Settings → Activity. Never logs the secret values themselves —
            // only lengths and a short fingerprint so we can compare safely.
            const fp = (s: string | null | undefined) =>
              s ? `${s.slice(0, 2)}…${s.slice(-2)}` : "(none)";
            let details: string;
            if (!expected) {
              details = "Server missing GMAIL_WEBHOOK_TOKEN secret";
            } else if (!provided) {
              details = `Push had no ?token= query param (expected length ${expected.length}, fp ${fp(expected)})`;
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
        }
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
              // Immediately drain newly-enqueued message_jobs so the email row
              // lands in `emails` (and the Inbox realtime subscription fires)
              // within this same push request. When there's a visible backlog
              // (e.g. cron was down or a burst arrived), drain more aggressively
              // up to a hard cap so a single push can catch us up.
              try {
                const { count: pendingCount } = await supabaseAdmin
                  .from("message_jobs")
                  .select("id", { count: "exact", head: true })
                  .eq("status", "pending");
                const backlog = pendingCount ?? 0;
                const target = Math.max(enqueuedCount + 5, backlog);
                const limit = Math.min(Math.max(target, 0), 100);
                if (limit > 0) await runMessageJobs(limit);
              } catch (e) {
                console.error("inline runMessageJobs failed", e);
              }

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
