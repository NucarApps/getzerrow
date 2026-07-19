import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  getOwnedAccount,
  getEmailAccount,
  getOwnedFolder,
  getOwnedSchedule,
  extractDomain,
  drainCatchupRounds,
  ianaTz,
} from "../gmail-helpers.server";
import { performMove } from "../move-email.server";
import {
  backfillRecent,
  backfillWindow,
  syncSinceHistory,
  learnFromLinkedLabel,
  reconcileLocalInbox,
  loadOlderFromLabel,
  runMessageJobs,
  retryMessageJob,
  enqueueMessageJob,
  startBackfillJob,
  cancelBackfillJob,
  invalidateAccountContext,
  invalidateAccountContextForUser,
  bulkCatchupClaim,
  syncReadState,
} from "../sync.server";
import { CATCHUP_MAX_ROUNDS, CATCHUP_TOTAL_BUDGET_MS } from "../sync/config";
import {
  listLabels,
  createLabel,
  modifyMessage,
  batchModifyMessages,
  trashMessage,
  sendMessage,
  ensureWatch,
  stopWatch,
  listMessages,
  getMessage,
  getMessageMetadata,
  getMessageLabels,
  getThread,
  parseMessage,
} from "../gmail.server";
import {
  suggestReply,
  suggestRuleUpdates,
  suggestFolderFromEmails,
  generateAiRuleFromPurpose,
  generateAiRuleFromLabelSamples,
} from "../ai.server";
import { computeNextRun, enqueueFolderSummaryJob, runFolderSummary } from "../summaries.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { signState, buildAuthorizeUrl, getRedirectUri } from "../google-oauth.server";
import { getRequestHost } from "@tanstack/react-start/server";
import { logError, logAudit } from "../log.server";
import { removeLabelsFromCurrent } from "../sync/label-merge";
import { buildGmailQueries } from "../sync/gmail-query-builder";
import { matchByFilters, emailVetoedForFolder } from "../sync/filter-engine";
import type { Folder, Filter, RuleNode } from "../sync/types";
import {
  upsertEmailEncrypted,
  updateEmailEncrypted,
  setReplyDraftEncrypted,
  insertFolderExampleEncrypted,
} from "../sync/encrypted-writer";
import { getEmailsDecrypted } from "../sync/encrypted-reader";
export const stripFolderLabelPast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { value: string; match_type: "email" | "domain" }) =>
    z
      .object({
        value: z.string().min(1).max(320),
        match_type: z.enum(["email", "domain"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const value = data.value.trim().toLowerCase().replace(/^@/, "");
    if (!value) throw new Error("Empty value");

    let q = supabaseAdmin
      .from("emails")
      .select("id, gmail_message_id, gmail_account_id, folder_id, from_addr, raw_labels")
      .eq("user_id", context.userId)
      .not("folder_id", "is", null);
    if (data.match_type === "email") {
      q = q.ilike("from_addr", value);
    } else {
      q = q.ilike("from_addr", `%@${value}`);
    }
    const { data: rows } = await q;
    const matches = (rows ?? []).filter((r) => {
      const fa = (r.from_addr || "").toLowerCase();
      return data.match_type === "email" ? fa === value : fa.split("@")[1] === value;
    });

    let stripped_count = 0;
    if (matches.length) {
      const folderIds = Array.from(
        new Set(matches.map((m) => m.folder_id).filter((x): x is string => !!x)),
      );
      const { data: fs } = await supabaseAdmin
        .from("folders")
        .select("id, gmail_label_id")
        .in("id", folderIds);
      const labelById = new Map((fs ?? []).map((f) => [f.id, f.gmail_label_id]));
      const reason = "Right-click: removed folder label";

      const concurrency = 5;
      let i = 0;
      async function worker() {
        while (i < matches.length) {
          const m = matches[i++];
          try {
            await updateEmailEncrypted({
              email_id: m.id,
              classification_reason: reason,
              ai_summary: "",
            });
            await supabaseAdmin
              .from("emails")
              .update({
                folder_id: null,
                is_archived: !((m.raw_labels ?? []) as string[]).includes("INBOX"),
                classified_by: "manual_strip",
                matched_filter_ids: [],
              })
              .eq("id", m.id);
            const oldLabel = m.folder_id ? labelById.get(m.folder_id) : null;
            if (oldLabel) {
              try {
                await modifyMessage(m.gmail_account_id, m.gmail_message_id, [], [oldLabel]);
              } catch (e) {
                logError("gmail.strip.label_failed", { email_id: m.id }, e);
              }
            }
            stripped_count++;
          } catch (e) {
            logError("gmail.strip.row_failed", { email_id: m.id }, e);
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, matches.length) }, worker));
    }

    return { ok: true, stripped_count };
  });

/**
 * Search Gmail directly and ingest any matching messages we don't already
 * have locally. Used as a fallback when the local search corpus is missing
 * recent or older messages.
 */
export const searchGmailAndIngest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { query: string; account_id?: string }) =>
    z
      .object({
        query: z.string().min(1).max(200),
        account_id: z.string().uuid().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // Resolve the gmail accounts to search across.
    const accountIds: string[] = [];
    if (data.account_id) {
      await getOwnedAccount(context.userId, data.account_id);
      accountIds.push(data.account_id);
    } else {
      const { data: accts } = await supabaseAdmin
        .from("gmail_accounts")
        .select("id")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: true });
      for (const a of accts ?? []) accountIds.push(a.id);
      if (accountIds.length === 0) return { ingested: 0, found: 0, reason: "no_account" as const };
    }

    // Build a Gmail query. If it looks like an email address or domain, use
    // `from:` so we hit sender matches across the entire mailbox; otherwise
    // pass the raw text and let Gmail's full-text search work.
    const raw = data.query.trim();
    const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
    const looksLikeDomain = /^@?[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw) && !raw.includes(" ");
    // Explicit Gmail-style operator queries (from:/to:) get a "deep" search:
    // page further into older results so old senders aren't capped by the
    // single-page 50-result window.
    // Always page deeply — free-text searches like "rob morris" need to
    // reach older mail, not just the 50 newest Gmail hits.
    const isDeep = true;
    let q: string;
    if (looksLikeEmail) q = `from:${raw}`;
    else if (looksLikeDomain) q = `from:${raw.replace(/^@/, "")}`;
    else q = raw;

    let totalIngested = 0;
    let totalFound = 0;
    let reauthFailures = 0;
    let rateLimited = false;
    const hitGmailMessageIds: string[] = [];

    const isRateLimit = (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return /rateLimitExceeded|Quota exceeded|userRateLimitExceeded|429/i.test(msg);
    };

    for (const accountId of accountIds) {
      try {
        // Page Gmail search results modestly. Going wider triggers per-user
        // quota errors; 2x100 covers the vast majority of name searches.
        const PAGE = 100;
        const MAX_PAGES = isDeep ? 2 : 1;
        const hits: Array<{ id: string; threadId: string }> = [];
        let pageToken: string | undefined;
        for (let p = 0; p < MAX_PAGES; p++) {
          try {
            const list = await listMessages(accountId, { q, maxResults: PAGE, pageToken });
            for (const m of list.messages ?? []) hits.push(m);
            pageToken = list.nextPageToken;
            if (!pageToken) break;
          } catch (e) {
            if (isRateLimit(e)) {
              rateLimited = true;
              break;
            }
            throw e;
          }
        }
        if (hits.length === 0) continue;

        // Use only direct Gmail search hits (no thread expansion) so we don't
        // burn Gmail per-minute quota fetching unrelated thread messages.
        const allMessageIds = new Set<string>(hits.map((m) => m.id));

        const idsArr = Array.from(allMessageIds);
        for (const id of idsArr) hitGmailMessageIds.push(id);
        totalFound += idsArr.length;
        const { data: existing } = await supabaseAdmin
          .from("emails")
          .select("gmail_message_id")
          .eq("user_id", context.userId)
          .in("gmail_message_id", idsArr);
        const known = new Set((existing ?? []).map((r) => r.gmail_message_id));
        const todo = idsArr.filter((id) => !known.has(id));

        // Cache folder label → folder_id mapping for this account.
        const { data: folders } = await supabaseAdmin
          .from("folders")
          .select("id, gmail_label_id")
          .eq("user_id", context.userId)
          .eq("gmail_account_id", accountId);
        const labelToFolder = new Map<string, string>();
        for (const f of folders ?? []) {
          if (f.gmail_label_id) labelToFolder.set(f.gmail_label_id, f.id);
        }

        // Load folder_filters for this user so newly-ingested messages
        // honor existing domain / sender / subject rules instead of
        // landing as un-classified gmail_search_ingest rows.
        const folderIds = (folders ?? []).map((f) => f.id);
        type Filter = { id: string; folder_id: string; field: string; op: string; value: string };
        let filters: Filter[] = [];
        if (folderIds.length > 0) {
          const { data: ff } = await supabaseAdmin
            .from("folder_filters")
            .select("id, folder_id, field, op, value")
            .in("folder_id", folderIds);
          filters = (ff ?? []) as Filter[];
        }
        function matchFilters(parsed: {
          from_addr: string;
          from_name: string;
          to_addrs: string;
          subject: string;
          body_text: string;
          has_attachment: boolean;
        }): { folder_id: string; field: string; value: string } | null {
          for (const f of filters) {
            const v = (f.value || "").toLowerCase();
            const fieldVal = (() => {
              switch (f.field) {
                case "from":
                  return `${parsed.from_addr} ${parsed.from_name}`.toLowerCase();
                case "to":
                  return (parsed.to_addrs || "").toLowerCase();
                case "subject":
                  return (parsed.subject || "").toLowerCase();
                case "body":
                  return (parsed.body_text || "").toLowerCase();
                case "domain":
                  return (parsed.from_addr.split("@")[1] || "").toLowerCase();
                case "has_attachment":
                  return parsed.has_attachment ? "true" : "false";
                default:
                  return "";
              }
            })();
            const hit = (() => {
              switch (f.op) {
                case "contains":
                  return fieldVal.includes(v);
                case "equals":
                  return fieldVal === v;
                case "regex":
                  try {
                    return new RegExp(f.value, "i").test(fieldVal);
                  } catch {
                    return false;
                  }
                default:
                  return false;
              }
            })();
            if (hit) return { folder_id: f.folder_id, field: f.field, value: v };
          }
          return null;
        }

        // Low concurrency + stop early on rate-limit to stay within Gmail's
        // per-minute quota (~250 calls/user/min, shared with sync).
        const CONCURRENCY = 3;
        let i = 0;
        let stop = false;
        async function worker() {
          while (i < todo.length && !stop) {
            const id = todo[i++];
            try {
              const raw = await getMessage(accountId, id);
              const p = parseMessage(raw);
              let folder_id: string | null = null;
              let classified_by: string = "gmail_search_ingest";
              let classification_reason: string | null = "Pulled from Gmail via search";
              for (const lbl of p.raw_labels ?? []) {
                const fid = labelToFolder.get(lbl);
                if (fid) {
                  folder_id = fid;
                  classified_by = "gmail_label";
                  classification_reason = "Matched Gmail label";
                  break;
                }
              }
              if (!folder_id) {
                const m = matchFilters({
                  from_addr: p.from_addr ?? "",
                  from_name: p.from_name ?? "",
                  to_addrs: p.to_addrs ?? "",
                  subject: p.subject ?? "",
                  body_text: p.body_text ?? "",
                  has_attachment: !!p.has_attachment,
                });
                if (m) {
                  folder_id = m.folder_id;
                  classified_by = m.field === "domain" ? "domain_rule" : "filter";
                  classification_reason =
                    m.field === "domain"
                      ? `Domain rule: ${m.value}`
                      : `Folder rule: ${m.field} ${m.value}`;
                }
              }
              const { id: newId, error } = await upsertEmailEncrypted({
                user_id: context.userId,
                gmail_account_id: accountId,
                gmail_message_id: p.gmail_message_id,
                thread_id: p.thread_id,
                from_addr: p.from_addr,
                from_name: p.from_name,
                to_addrs: p.to_addrs,
                cc: null,
                list_id: null,
                in_reply_to: null,
                subject: p.subject,
                snippet: p.snippet,
                body_text: p.body_text,
                body_html: p.body_html,
                received_at: p.received_at,
                is_read: p.is_read,
                is_archived: !(p.raw_labels ?? []).includes("INBOX"),
                has_attachment: p.has_attachment,
                raw_labels: p.raw_labels,
                classified_by: classified_by ?? "pending",
                processed_at: null,
                published_at_ms: null,
              });
              if (!error) {
                totalIngested++;
                if (newId && folder_id) {
                  await updateEmailEncrypted({
                    email_id: newId,
                    folder_id,
                    ai_confidence: 1,
                    classification_reason,
                  });
                }
              } else
                logError(
                  "gmail.search_ingest.insert_failed",
                  { account_id: accountId, gmail_message_id: id },
                  { message: error },
                );
            } catch (e) {
              if (isRateLimit(e)) {
                rateLimited = true;
                stop = true;
                break;
              }
              logError(
                "gmail.search_ingest.one_failed",
                { account_id: accountId, gmail_message_id: id },
                e,
              );
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/missing OAuth tokens|reauthorize|invalid_grant/i.test(msg)) {
          reauthFailures++;
        }
        if (isRateLimit(e)) rateLimited = true;
        logError("gmail.search_ingest.account_failed", { account_id: accountId }, e);
      }
    }

    if (reauthFailures > 0 && reauthFailures === accountIds.length) {
      return {
        ingested: 0,
        found: 0,
        reason: "reauth_required" as const,
        hit_gmail_message_ids: [] as string[],
      };
    }
    return {
      ingested: totalIngested,
      found: totalFound,
      hit_gmail_message_ids: hitGmailMessageIds,
      ...(rateLimited ? { reason: "rate_limited" as const } : {}),
    };
  });

export const listPubsubEvents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        event_type: z
          .enum([
            "push",
            "push_empty",
            "poll",
            "watch_renew",
            "watch_rearm_auto",
            "gmail_api_error",
            "webhook_test",
          ])
          .optional(),
        only_errors: z.boolean().optional(),
        limit: z.number().min(1).max(500).optional(),
        account_id: z.string().uuid().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const limit = data.limit ?? 100;

    // Scope all diagnostics to the caller's own Gmail accounts to avoid
    // leaking other users' email addresses / sync metadata. When account_id
    // is supplied, narrow to that one account.
    let acctQ = supabaseAdmin
      .from("gmail_accounts")
      .select("id, email_address")
      .eq("user_id", context.userId);
    if (data.account_id) acctQ = acctQ.eq("id", data.account_id);
    const { data: myAccounts } = await acctQ;
    const myEmails = (myAccounts ?? []).map((a) => a.email_address).filter(Boolean) as string[];
    const myAccountIds = (myAccounts ?? []).map((a) => a.id);

    // If the user has no connected accounts, return an empty diagnostics shape.
    if (myEmails.length === 0) {
      const host = getRequestHost();
      return {
        events: [],
        stats: {
          push24: 0,
          poll24: 0,
          renew24: 0,
          accounts24: 0,
          synced24: 0,
          errors24: 0,
          gmailErrors24: 0,
          pushEmpty24: 0,
          pushUnmatched24: 0,
          lastReceivedAt: null,
          lastPollAt: null,
          lastPushAt: null,
        },
        diagnostics: {
          lastPush: null,
          lastWatchRenew: null,
          lastWebhookTest: null,
          webhookUrl: `https://${host}/api/public/gmail-webhook`,
          pubsubTopic: process.env.GMAIL_PUBSUB_TOPIC ?? null,
          stuckJobs: [],
        },
      };
    }

    let q = supabaseAdmin
      .from("pubsub_events")
      .select(
        "id, received_at, event_type, email_address, history_id, accounts_matched, synced_count, error, message_id, publish_time, subscription, payload, details",
      )
      .in("email_address", myEmails)
      .order("received_at", { ascending: false })
      .limit(limit);
    if (data.event_type) q = q.eq("event_type", data.event_type);
    if (data.only_errors) q = q.not("error", "is", null);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: agg } = await supabaseAdmin
      .from("pubsub_events")
      .select("event_type, accounts_matched, synced_count, error, received_at")
      .in("email_address", myEmails)
      .gte("received_at", since)
      .limit(5000);

    let push24 = 0,
      poll24 = 0,
      renew24 = 0,
      accounts24 = 0,
      synced24 = 0,
      errors24 = 0,
      gmailErrors24 = 0,
      pushEmpty24 = 0,
      pushUnmatched24 = 0;
    let lastPollAt: string | null = null;
    let lastPushAt: string | null = null;
    for (const r of agg ?? []) {
      if (r.event_type === "push") {
        push24++;
        if (!lastPushAt || r.received_at > lastPushAt) lastPushAt = r.received_at;
        if ((r.accounts_matched ?? 0) === 0) pushUnmatched24++;
      } else if (r.event_type === "push_empty") {
        pushEmpty24++;
      } else if (r.event_type === "poll") {
        poll24++;
        if (!lastPollAt || r.received_at > lastPollAt) lastPollAt = r.received_at;
      } else if (r.event_type === "watch_renew" || r.event_type === "watch_rearm_auto") {
        renew24++;
      } else if (r.event_type === "gmail_api_error") {
        gmailErrors24++;
      }
      accounts24 += r.accounts_matched ?? 0;
      synced24 += r.synced_count ?? 0;
      if (r.error) errors24++;
    }

    // Most recent REAL push from Google (synthetic webhook_test rows are
    // excluded — they're app-side tests, not proof of GCP delivery).
    const cols =
      "id, received_at, event_type, email_address, history_id, accounts_matched, synced_count, error, message_id, publish_time, subscription, payload, details";
    const { data: anyPushRows } = await supabaseAdmin
      .from("pubsub_events")
      .select(cols)
      .in("email_address", myEmails)
      .in("event_type", ["push", "push_empty"])
      .order("received_at", { ascending: false })
      .limit(1);
    const lastPush = anyPushRows?.[0] ?? null;

    // Most recent webhook self-test (separate from real pushes).
    const { data: lastTestRows } = await supabaseAdmin
      .from("pubsub_events")
      .select(cols)
      .in("email_address", myEmails)
      .eq("event_type", "webhook_test")
      .order("received_at", { ascending: false })
      .limit(1);
    const lastWebhookTest = lastTestRows?.[0] ?? null;

    const { data: lastRenewRows } = await supabaseAdmin
      .from("pubsub_events")
      .select("received_at, details, email_address, history_id")
      .in("email_address", myEmails)
      .in("event_type", ["watch_renew", "watch_rearm_auto"])
      .order("received_at", { ascending: false })
      .limit(1);
    const lastWatchRenew = lastRenewRows?.[0] ?? null;

    const host = getRequestHost();
    const webhookUrl = `https://${host}/api/public/gmail-webhook`;

    // Stuck jobs: status='running' for > 2 minutes (worker died mid-processing).
    const stuckCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: stuckJobs } = await supabaseAdmin
      .from("message_jobs")
      .select("id, gmail_message_id, gmail_account_id, attempt, locked_at, from_addr, subject")
      .in("gmail_account_id", myAccountIds)
      .eq("status", "running")
      .lt("locked_at", stuckCutoff)
      .order("locked_at", { ascending: true })
      .limit(25);

    // Pending jobs count + oldest pending — surfaces "push fired, processing backlogged"
    const { count: pendingCount } = await supabaseAdmin
      .from("message_jobs")
      .select("id", { count: "exact", head: true })
      .in("gmail_account_id", myAccountIds)
      .eq("status", "pending");
    const { data: oldestPendingRow } = await supabaseAdmin
      .from("message_jobs")
      .select("created_at")
      .in("gmail_account_id", myAccountIds)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    return {
      events: rows ?? [],
      stats: {
        push24,
        poll24,
        renew24,
        accounts24,
        synced24,
        errors24,
        gmailErrors24,
        pushEmpty24,
        pushUnmatched24,
        lastReceivedAt: rows?.[0]?.received_at ?? null,
        lastPollAt,
        lastPushAt,
      },
      diagnostics: {
        lastPush,
        lastWatchRenew,
        lastWebhookTest,
        webhookUrl,
        pubsubTopic: process.env.GMAIL_PUBSUB_TOPIC ?? null,
        stuckJobs: stuckJobs ?? [],
        pendingJobs: pendingCount ?? 0,
        oldestPendingAt: oldestPendingRow?.created_at ?? null,
      },
    };
  });

/** Re-pull the current Gmail label state for a single message and reconcile our row. */
export const resyncMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const email = await getEmailAccount(context.userId, data.id);
    const labels = await getMessageLabels(email.gmail_account_id, email.gmail_message_id);
    if (labels === null) {
      await supabaseAdmin.from("emails").delete().eq("id", data.id);
      return { deleted: true };
    }
    if (labels.includes("TRASH")) {
      await supabaseAdmin.from("emails").delete().eq("id", data.id);
      return { deleted: true };
    }
    const inInbox = labels.includes("INBOX");
    const unread = labels.includes("UNREAD");
    await supabaseAdmin
      .from("emails")
      .update({
        raw_labels: labels,
        is_archived: !inInbox,
        is_read: !unread,
      })
      .eq("id", data.id);
    return { in_inbox: inInbox, unread, labels };
  });

/**
 * Self-heal the Inbox view by asking Gmail which of the user's locally-
 * "in inbox" messages are actually still in INBOX. Any local row whose
 * gmail_message_id is missing from Gmail's current top-N inbox slice has
 * been archived (or deleted) externally and is reconciled in place.
 *
 * Costs ONE Gmail list call + at most a handful of per-message label
 * fetches for the drifted ids, regardless of how many emails are shown.
 */
export const reconcileInboxFromGmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { gmail_account_id: string }) =>
    z.object({ gmail_account_id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.gmail_account_id);

    // Fetch the locally-inbox rows for this account (newest first). Cap
    // matches the Gmail INBOX slice we pull below so we never miss a row
    // by paging past it.
    const LIMIT = 500;
    const { data: localRows } = await supabaseAdmin
      .from("emails")
      .select("id, gmail_message_id, received_at")
      .eq("gmail_account_id", data.gmail_account_id)
      .eq("user_id", context.userId)
      .eq("is_archived", false)
      .contains("raw_labels", ["INBOX"])
      .order("received_at", { ascending: false, nullsFirst: false })
      .limit(LIMIT);

    const rows = (localRows ?? []) as Array<{
      id: string;
      gmail_message_id: string;
      received_at: string | null;
    }>;

    // Pull the current Gmail INBOX slice in one call. maxResults caps at 500.
    const gmailInbox = new Set<string>();
    try {
      const list = await listMessages(data.gmail_account_id, {
        labelIds: ["INBOX"],
        maxResults: 500,
      });
      for (const m of list.messages ?? []) gmailInbox.add(m.id);
    } catch (e) {
      logError(
        "reconcile.inbox_list_failed",
        { account_id: data.gmail_account_id, user_id: context.userId },
        e,
      );
      return {
        checked: 0,
        reconciled: 0,
        deleted: 0,
        restored: 0,
        ingested: 0,
        error: (e as Error).message,
      };
    }

    // ── Outgoing pass ──────────────────────────────────────────────────
    // Local rows that look like they're in the inbox but Gmail has since
    // archived/trashed them. Anchor to the 500-row Gmail slice; older rows
    // may genuinely still be in inbox but past our window — the cron
    // reconcile covers those.
    const drifted = rows.filter((r) => !gmailInbox.has(r.gmail_message_id));

    // Cap per-call repair work so a one-off divergence can't hammer the
    // Gmail API on every poll. The cron reconcile mops up the rest.
    const MAX_REPAIR = 25;
    let reconciled = 0;
    let deleted = 0;
    for (const r of drifted.slice(0, MAX_REPAIR)) {
      try {
        const labels = await getMessageLabels(data.gmail_account_id, r.gmail_message_id);
        if (labels === null || labels.includes("TRASH")) {
          await supabaseAdmin.from("emails").delete().eq("id", r.id);
          deleted++;
          continue;
        }
        const inInbox = labels.includes("INBOX");
        const unread = labels.includes("UNREAD");
        await supabaseAdmin
          .from("emails")
          .update({
            raw_labels: labels,
            is_archived: !inInbox,
            is_read: !unread,
          })
          .eq("id", r.id);
        if (!inInbox) reconciled++;
      } catch (e) {
        logError(
          "reconcile.message_repair_failed",
          { account_id: data.gmail_account_id, gmail_message_id: r.gmail_message_id },
          e,
        );
      }
    }

    // ── Incoming pass ──────────────────────────────────────────────────
    // Messages that ARE in Gmail's inbox right now but are NOT visible in
    // Zerrow's inbox — either archived locally / missing the INBOX label
    // (e.g. un-snoozed, or manually moved back to the inbox in Gmail), or
    // never ingested at all. Without this, the history `labelsAdded: INBOX`
    // event being missed leaves them stuck out of the inbox forever.
    let restored = 0;
    let ingested = 0;
    const gmailIds = Array.from(gmailInbox);
    if (gmailIds.length > 0) {
      // Fetch the local state of every Gmail-inbox message in chunks (the
      // `.in()` list can be up to 500 ids).
      type LocalState = {
        id: string;
        gmail_message_id: string;
        is_archived: boolean;
        raw_labels: string[] | null;
      };
      const localById = new Map<string, LocalState>();
      for (let i = 0; i < gmailIds.length; i += 200) {
        const chunk = gmailIds.slice(i, i + 200);
        const { data: found } = await supabaseAdmin
          .from("emails")
          .select("id, gmail_message_id, is_archived, raw_labels")
          .eq("gmail_account_id", data.gmail_account_id)
          .eq("user_id", context.userId)
          .in("gmail_message_id", chunk);
        for (const row of (found ?? []) as LocalState[]) {
          localById.set(row.gmail_message_id, row);
        }
      }

      const missing: string[] = [];
      // Rows that exist locally but aren't showing in the inbox view.
      const toRestore = gmailIds.filter((id) => {
        const row = localById.get(id);
        if (!row) {
          missing.push(id);
          return false;
        }
        const hasInboxLabel = (row.raw_labels ?? []).includes("INBOX");
        return row.is_archived || !hasInboxLabel;
      });

      // Restore local rows in-place: clear archived state, re-add the INBOX
      // label, and lift any stale snooze so they resurface immediately via
      // the realtime subscription. Capped to bound Gmail/DB work per call.
      for (const id of toRestore.slice(0, MAX_REPAIR)) {
        const row = localById.get(id)!;
        try {
          const nextLabels = Array.from(new Set([...(row.raw_labels ?? []), "INBOX"]));
          await supabaseAdmin
            .from("emails")
            .update({
              is_archived: false,
              raw_labels: nextLabels,
              snoozed_until: null,
            })
            .eq("id", row.id);
          restored++;
        } catch (e) {
          logError(
            "reconcile.inbox_restore_failed",
            { account_id: data.gmail_account_id, gmail_message_id: id },
            e,
          );
        }
      }

      // Messages with no local row at all — enqueue through the normal
      // ingestion pipeline so they're parsed, classified, and inserted.
      if (missing.length > 0) {
        const toIngest = missing.slice(0, MAX_REPAIR);
        for (const id of toIngest) {
          try {
            await enqueueMessageJob(data.gmail_account_id, context.userId, id);
            ingested++;
          } catch (e) {
            logError(
              "reconcile.inbox_ingest_enqueue_failed",
              { account_id: data.gmail_account_id, gmail_message_id: id },
              e,
            );
          }
        }
      }
    }

    return {
      checked: rows.length,
      drifted: drifted.length,
      reconciled,
      deleted,
      restored,
      ingested,
    };
  });

/**
 * Surface push→ack and push→visible latency percentiles over the last N
 * hours, scoped to the caller's mailboxes. Backed by a SECURITY DEFINER
 * SQL function so we can compute percentile_cont() in one roundtrip
 * instead of paginating raw rows back to JS.
 */
