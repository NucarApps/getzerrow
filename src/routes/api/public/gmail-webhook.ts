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
import { topUpWatch } from "@/lib/gmail.server";
import { verifyGoogleJwt } from "@/lib/google-jwt.server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth.server";
import { logError, newRunId } from "@/lib/log.server";

// Pub/Sub considers a push delivered if we ack within ~10s. We spend up to
// INLINE_DRAIN_BUDGET_MS draining the priority=0 queue inline so brand-new
// mail is visible before the response is returned, then ack. Anything left
// in the queue gets picked up by the dedicated 5s gmail-process-jobs cron.
const INLINE_DRAIN_BUDGET_MS = 4_000;

async function drainWithBudget(budgetMs: number): Promise<{ rounds: number; processed: number }> {
  const deadline = Date.now() + budgetMs;
  let rounds = 0;
  let processed = 0;
  let emptyRounds = 0;
  while (Date.now() < deadline) {
    const r = await runMessageJobs(25, 16, { priority: 0 });
    rounds++;
    processed += r.processed ?? 0;
    if ((r.processed ?? 0) === 0) {
      // Enqueue jitter is 0-500ms; if we hit two empty rounds in a row, the
      // queue is genuinely drained and we can return early instead of busy-
      // looping until the budget runs out.
      emptyRounds++;
      if (emptyRounds >= 2) break;
      await new Promise((r) => setTimeout(r, 300));
    } else {
      emptyRounds = 0;
    }
  }
  return { rounds, processed };
}

export const Route = createFileRoute("/api/public/gmail-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runId = newRunId();
        const tStart = Date.now();
        // Synthetic test requests must still be authenticated with the
        // CRON_SECRET — otherwise anyone could trigger Gmail syncs for any
        // known email address by setting the x-zerrow-test header.
        const isTest =
          request.headers.get("x-zerrow-test") === "1" && (await isAuthorizedCronRequest(request));

        // Authenticate Pub/Sub push. Preferred: OIDC bearer JWT signed by
        // Google (set on the subscription via pushConfig.oidcToken). Fallback:
        // legacy `?token=` shared secret. Authenticated test calls are exempt.
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
                logError("webhook.pubsub_log_failed", { run_id: runId, kind: "push_unauthorized_oidc" }, logErr);
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
                logError("webhook.pubsub_log_failed", { run_id: runId, kind: "push_unauthorized_legacy" }, logErr);
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
              logError("webhook.pubsub_log_failed", { run_id: runId, kind: "push_legacy_auth" }, logErr);
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
                logError("webhook.pubsub_log_failed", { run_id: runId, kind: "push_duplicate", message_id: messageId }, logErr);
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
                .select("id, email_address, watch_expiration, needs_reconnect")
                .eq("email_address", emailAddress);
              // Skip dead-OAuth accounts entirely — every Gmail call would
              // throw with the same NeedsReconnectError and there's nothing
              // we can do until the user reconnects in the UI.
              const liveAccounts = (accounts ?? []).filter((a) => !a.needs_reconnect);
              accountsMatched = liveAccounts.length;
              if ((accounts?.length ?? 0) > 0 && liveAccounts.length === 0) {
                details = `Account(s) for "${emailAddress}" need reconnect — skipped.`;
              } else if (accountsMatched === 0) {
                details = `No gmail_accounts row matches "${emailAddress}" — watch was probably created against a different connected account.`;
              }
              const publishedAtMs = publishTime ? new Date(publishTime).getTime() : null;
              for (const acc of liveAccounts) {
                try {
                  // syncSinceHistory now holds a per-account lock internally,
                  // so overlapping pushes coalesce into one history-diff pass.
                  const r = await syncSinceHistory(acc.id, { publishedAtMs });
                  if (r && typeof (r as { synced?: number }).synced === "number") {
                    enqueuedCount += (r as { synced: number }).synced;
                  }
                  // Opportunistic watch top-up: if this account's watch will
                  // expire within 72h, re-arm it inline. Belt-and-suspenders
                  // alongside the renewal cron — if cron is broken (which IS
                  // how watches lapse in practice), a healthy push channel
                  // keeps itself alive.
                  try {
                    const w = await topUpWatch(acc.id, acc.watch_expiration);
                    if (w) {
                      await supabaseAdmin.from("gmail_accounts").update({
                        history_id: w.historyId,
                        watch_expiration: new Date(parseInt(w.expiration, 10)).toISOString(),
                      }).eq("id", acc.id);
                      await supabaseAdmin.from("pubsub_events").insert({
                        event_type: "watch_renew",
                        email_address: acc.email_address,
                        history_id: w.historyId,
                        details: "Opportunistic top-up from push webhook",
                      });
                    }
                  } catch (topUpErr) {
                    // Non-fatal — renewal cron will retry.
                    logError("webhook.topup_failed", {
                      run_id: runId,
                      account_id: acc.id,
                      email_address: acc.email_address,
                      message_id: messageId,
                    }, topUpErr);
                  }
                } catch (e) {
                  logError("webhook.sync_failed", {
                    run_id: runId,
                    account_id: acc.id,
                    email_address: acc.email_address,
                    history_id: historyId,
                    message_id: messageId,
                    duration_ms: Date.now() - tStart,
                  }, e);
                  errorMsg = (e as Error)?.message ?? String(e);
                }
              }
              // Drain inline within a 4s budget. Cuts push→visible latency
              // from "wait for next live-cron tick" (0-5s) to "wait for one
              // Gmail message fetch + classify" (≈300ms-1s). Pub/Sub still
              // gets its ack well inside the 10s deadline; anything we don't
              // finish stays on the queue for gmail-process-jobs.
              //
              // Gate on enqueuedCount only — accountsMatched > 0 fires on
              // every push (including label-only changes that produced no
              // new mail), and an unnecessary 4s drain on every push isn't
              // free.
              if (enqueuedCount > 0) {
                try {
                  await drainWithBudget(INLINE_DRAIN_BUDGET_MS);
                } catch (e) {
                  logError("webhook.inline_drain_failed", {
                    run_id: runId,
                    email_address: emailAddress,
                    message_id: messageId,
                    enqueued: enqueuedCount,
                  }, e);
                }
              }
            }
          }
        } catch (e: unknown) {
          const err = e as Error;
          logError("webhook.handler_error", {
            run_id: runId,
            message_id: messageId,
            email_address: emailAddress,
            duration_ms: Date.now() - tStart,
          }, err);
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
            // End-to-end latency: time from Pub/Sub publishTime to the
            // moment we recorded this row. Lets ops query p50/p95 push→ack
            // latency in one SQL.
            const latencyMs = publishTime
              ? Math.max(0, Date.now() - new Date(publishTime).getTime())
              : null;
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
              latency_ms: latencyMs,
              details: isTest
                ? `App-side webhook test — ${details ?? (hadData && accountsMatched > 0 ? "matched account and ran sync" : "synthetic envelope")}`
                : details,
            });
          } catch (logErr) {
            logError("webhook.pubsub_log_failed", { run_id: runId, kind: "summary", message_id: messageId }, logErr);
          }
        }
        return new Response("ok", { status: 200 });
      },
    },
  },
});
