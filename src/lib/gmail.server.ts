// Gmail API helpers — direct calls to Google with per-user OAuth tokens. Server-only.
import { getAccessToken } from "./google-oauth.server";

const BASE = "https://gmail.googleapis.com/gmail/v1";
const REQUEST_TIMEOUT_MS = 20_000;

export class GmailApiError extends Error {
  status: number;
  retryable: boolean;
  /** Seconds to wait before next attempt, parsed from `Retry-After` on 429s. */
  retryAfterSeconds: number | null;
  /** True when the underlying reason is `quotaExceeded` (per-user quota
   * resets at midnight PT, not after a short backoff). */
  isQuotaExceeded: boolean;
  constructor(
    message: string,
    status: number,
    retryable: boolean,
    opts: { retryAfterSeconds?: number | null; isQuotaExceeded?: boolean } = {},
  ) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
    this.isQuotaExceeded = opts.isQuotaExceeded ?? false;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  // Either an integer of seconds, or an HTTP-date.
  const asInt = parseInt(header, 10);
  if (!Number.isNaN(asInt) && asInt > 0) return Math.min(asInt, 6 * 60 * 60);
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) {
    const secs = Math.floor((asDate - Date.now()) / 1000);
    return secs > 0 ? Math.min(secs, 6 * 60 * 60) : null;
  }
  return null;
}

function parseQuotaReason(body: string): boolean {
  // Google returns `{ error: { errors: [{ reason: "quotaExceeded" | "rateLimitExceeded" | "userRateLimitExceeded" }]}}`.
  return /quotaExceeded|userRateLimitExceeded/.test(body);
}

async function gmailFetch<T = any>(accountId: string, path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken(accountId);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
  } catch (e: any) {
    // Network error or AbortSignal timeout — treat as retryable.
    const msg = e?.name === "TimeoutError" || e?.name === "AbortError"
      ? `Gmail API timeout on ${path} (>${REQUEST_TIMEOUT_MS}ms)`
      : `Gmail API network error on ${path}: ${e?.message ?? String(e)}`;
    throw new GmailApiError(msg, 0, true);
  }
  const text = await res.text();
  if (!res.ok) {
    const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : null;
    const isQuota = res.status === 429 && parseQuotaReason(text);
    throw new GmailApiError(
      `Gmail API ${res.status} on ${path}: ${text.slice(0, 500)}`,
      res.status,
      isRetryableStatus(res.status),
      { retryAfterSeconds: retryAfter, isQuotaExceeded: isQuota },
    );
  }
  return text ? JSON.parse(text) : ({} as T);
}


export async function listLabels(accountId: string) {
  return gmailFetch<{ labels: Array<{ id: string; name: string; type: string }> }>(
    accountId,
    "/users/me/labels"
  );
}

export async function createLabel(accountId: string, name: string) {
  return gmailFetch<{ id: string; name: string }>(accountId, "/users/me/labels", {
    method: "POST",
    body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  });
}

export async function listMessages(
  accountId: string,
  opts: { maxResults?: number; q?: string; pageToken?: string; labelIds?: string[] } = {}
) {
  const params = new URLSearchParams();
  if (opts.maxResults) params.set("maxResults", String(opts.maxResults));
  if (opts.q) params.set("q", opts.q);
  if (opts.pageToken) params.set("pageToken", opts.pageToken);
  if (opts.labelIds) for (const id of opts.labelIds) params.append("labelIds", id);
  return gmailFetch<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string }>(
    accountId,
    `/users/me/messages?${params.toString()}`
  );
}

export async function getMessage(accountId: string, id: string) {
  return gmailFetch<any>(accountId, `/users/me/messages/${id}?format=full`);
}

export async function getThread(accountId: string, threadId: string) {
  return gmailFetch<{ id: string; messages?: any[] }>(
    accountId,
    `/users/me/threads/${threadId}?format=full`
  );
}

/** Headers-only fetch: From + Subject + snippet. ~10x smaller than format=full. */
export async function getMessageMetadata(accountId: string, id: string) {
  return gmailFetch<any>(
    accountId,
    `/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`
  );
}

/** Lightweight fetch: just labelIds. Returns null if message no longer exists (404). */
export async function getMessageLabels(accountId: string, id: string): Promise<string[] | null> {
  try {
    const r = await gmailFetch<{ labelIds?: string[] }>(accountId, `/users/me/messages/${id}?format=minimal`);
    return r.labelIds ?? [];
  } catch (e: any) {
    if (typeof e?.message === "string" && e.message.includes("404")) return null;
    throw e;
  }
}

export async function modifyMessage(accountId: string, id: string, addLabelIds: string[] = [], removeLabelIds: string[] = []) {
  return gmailFetch(accountId, `/users/me/messages/${id}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
}

/** Batch-modify up to 1000 message ids at once. Chunks larger inputs. Returns total processed. */
export async function batchModifyMessages(
  accountId: string,
  ids: string[],
  addLabelIds: string[] = [],
  removeLabelIds: string[] = [],
): Promise<number> {
  if (ids.length === 0) return 0;
  let processed = 0;
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    await gmailFetch(accountId, `/users/me/messages/batchModify`, {
      method: "POST",
      body: JSON.stringify({ ids: chunk, addLabelIds, removeLabelIds }),
    });
    processed += chunk.length;
  }
  return processed;
}

export async function trashMessage(accountId: string, id: string) {
  return gmailFetch(accountId, `/users/me/messages/${id}/trash`, { method: "POST" });
}

export async function sendMessage(accountId: string, to: string, subject: string, body: string, threadId?: string, inReplyTo?: string) {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
    inReplyTo ? `References: ${inReplyTo}` : "",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
  ].filter(Boolean).join("\r\n");
  const raw = Buffer.from(headers).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return gmailFetch(accountId, "/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw, threadId }),
  });
}

/** Insert an RFC 822 message directly into the user's mailbox (does NOT send). */
export async function insertMessage(
  accountId: string,
  rawRfc822: string,
  labelIds: string[] = ["INBOX", "UNREAD"]
) {
  const raw = Buffer.from(rawRfc822).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return gmailFetch<{ id: string; threadId: string }>(
    accountId,
    "/users/me/messages?internalDateSource=dateHeader",
    {
      method: "POST",
      body: JSON.stringify({ raw, labelIds }),
    }
  );
}

export async function listHistory(accountId: string, startHistoryId: string) {
  const params = new URLSearchParams({ startHistoryId });
  params.append("historyTypes", "messageAdded");
  params.append("historyTypes", "messageDeleted");
  params.append("historyTypes", "labelAdded");
  params.append("historyTypes", "labelRemoved");
  return gmailFetch<{
    history?: Array<{
      messages?: Array<{ id: string; threadId: string }>;
      messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }>;
      messagesDeleted?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }>;
      labelsAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] }; labelIds: string[] }>;
      labelsRemoved?: Array<{ message: { id: string; threadId: string; labelIds?: string[] }; labelIds: string[] }>;
    }>;
    historyId?: string;
  }>(accountId, `/users/me/history?${params.toString()}`);
}

export async function watchInbox(accountId: string, topicName: string) {
  return gmailFetch<{ historyId: string; expiration: string }>(accountId, "/users/me/watch", {
    method: "POST",
    // Watch the full mailbox so filter-routed mail that skips INBOX still triggers sync.
    body: JSON.stringify({ topicName }),
  });
}

export async function stopWatch(accountId: string) {
  return gmailFetch(accountId, "/users/me/stop", { method: "POST" });
}

// ---- Message parsing ----

type GmailHeader = { name: string; value: string };

function decodeBase64Url(data: string) {
  const norm = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(norm, "base64").toString("utf-8");
}

function extractPart(payload: any, mimeType: string): string {
  if (!payload) return "";
  if (payload.mimeType === mimeType && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      const v = extractPart(p, mimeType);
      if (v) return v;
    }
  }
  return "";
}

export function parseMessage(msg: any) {
  const payload = msg.payload || {};
  const headers: GmailHeader[] = payload.headers || [];
  const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || "";
  const from = h("from");
  const angle = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const fromName = (angle?.[1] || "").trim();
  const fromAddr = (angle?.[2] || from).trim();
  const bodyText = extractPart(payload, "text/plain");
  const bodyHtml = extractPart(payload, "text/html");
  const hasAttachment = (() => {
    const walk = (p: any): boolean => {
      if (!p) return false;
      if (p.filename) return true;
      return (p.parts || []).some(walk);
    };
    return (payload.parts || []).some(walk);
  })();
  return {
    gmail_message_id: msg.id as string,
    thread_id: msg.threadId as string,
    from_addr: fromAddr,
    from_name: fromName,
    to_addrs: h("to"),
    cc: h("cc"),
    list_id: h("list-id"),
    in_reply_to: h("in-reply-to"),
    subject: h("subject"),
    snippet: msg.snippet as string,
    body_text: bodyText,
    body_html: bodyHtml,
    received_at: new Date(parseInt(msg.internalDate, 10)).toISOString(),
    has_attachment: hasAttachment,
    raw_labels: (msg.labelIds || []) as string[],
    is_read: !(msg.labelIds || []).includes("UNREAD"),
  };
}

/** Ensure Gmail push watch is active for this account. Re-watches if expired or near expiry. */
export async function ensureWatch(accountId: string, watchExpiration: string | null): Promise<{ historyId: string; expiration: string } | null> {
  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) return null;
  if (watchExpiration) {
    const expMs = new Date(watchExpiration).getTime();
    // Renew if less than 2 days remaining. Tightened from 1 day so the every-6h
    // renewal cron can absorb a missed run without watches lapsing.
    if (expMs - Date.now() > 2 * 24 * 60 * 60 * 1000) return null;
  }
  return watchInbox(accountId, topic);
}
