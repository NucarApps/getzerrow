// Gmail API helpers via Lovable connector gateway. Server-only.
const GATEWAY_URL = "https://connector-gateway.lovable.dev/google_mail/gmail/v1";

function authHeaders() {
  const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
  const GOOGLE_MAIL_API_KEY = process.env.GOOGLE_MAIL_API_KEY;
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");
  if (!GOOGLE_MAIL_API_KEY) throw new Error("GOOGLE_MAIL_API_KEY is not configured. Connect Gmail in Settings.");
  return {
    Authorization: `Bearer ${LOVABLE_API_KEY}`,
    "X-Connection-Api-Key": GOOGLE_MAIL_API_KEY,
    "Content-Type": "application/json",
  };
}

async function gmailFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gmail API ${res.status} on ${path}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : ({} as T);
}

export async function listLabels() {
  return gmailFetch<{ labels: Array<{ id: string; name: string; type: string }> }>(
    "/users/me/labels"
  );
}

export async function createLabel(name: string) {
  return gmailFetch<{ id: string; name: string }>("/users/me/labels", {
    method: "POST",
    body: JSON.stringify({
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
  });
}

export async function listMessages(opts: { maxResults?: number; q?: string; pageToken?: string } = {}) {
  const params = new URLSearchParams();
  if (opts.maxResults) params.set("maxResults", String(opts.maxResults));
  if (opts.q) params.set("q", opts.q);
  if (opts.pageToken) params.set("pageToken", opts.pageToken);
  return gmailFetch<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string }>(
    `/users/me/messages?${params.toString()}`
  );
}

export async function getMessage(id: string) {
  return gmailFetch<any>(`/users/me/messages/${id}?format=full`);
}

export async function modifyMessage(id: string, addLabelIds: string[] = [], removeLabelIds: string[] = []) {
  return gmailFetch(`/users/me/messages/${id}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
}

export async function trashMessage(id: string) {
  return gmailFetch(`/users/me/messages/${id}/trash`, { method: "POST" });
}

export async function sendMessage(to: string, subject: string, body: string, threadId?: string, inReplyTo?: string) {
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
  return gmailFetch("/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw, threadId }),
  });
}

export async function listHistory(startHistoryId: string) {
  const params = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded" });
  return gmailFetch<{ history?: Array<{ messages?: Array<{ id: string; threadId: string }> }>; historyId?: string }>(
    `/users/me/history?${params.toString()}`
  );
}

export async function watchInbox(topicName: string) {
  return gmailFetch<{ historyId: string; expiration: string }>("/users/me/watch", {
    method: "POST",
    body: JSON.stringify({ topicName, labelIds: ["INBOX"], labelFilterAction: "include" }),
  });
}

export async function stopWatch() {
  return gmailFetch("/users/me/stop", { method: "POST" });
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
  const m = from.match(/^"?([^"<]*)"?\s*<?([^>]+)?>?$/);
  const fromName = (m?.[1] || "").trim();
  const fromAddr = (m?.[2] || from).trim();
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
