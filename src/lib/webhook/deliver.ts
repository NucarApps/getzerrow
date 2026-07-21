// Webhook delivery for the call_webhook action (rules upgrade, task 5).
//
// PAYLOAD — metadata + AI summary only by default. Email bodies are
// excluded unless the folder action explicitly opts in via include_body;
// even then only body_text is sent (never HTML).
//
// SIGNING — HMAC-SHA256 over `${timestamp}.${body}` with the action's
// decrypted secret, sent as `X-Zerrow-Signature: sha256=<hex>` plus
// `X-Zerrow-Timestamp`. Receivers reconstruct the signed string and
// compare with a constant-time equality check; binding the timestamp
// into the signature blocks replay of captured deliveries.
//
// Pure helpers (payload + signature) are separated from the fetch so
// tests cover them without network.
import { createHmac } from "crypto";
import { validateWebhookUrl } from "./url-guard";

export const WEBHOOK_TIMEOUT_MS = 10_000;

export type WebhookEmailFields = {
  id: string;
  thread_id: string | null;
  from_addr: string | null;
  from_name: string | null;
  subject: string | null;
  received_at: string | null;
  ai_summary: string | null;
  body_text?: string | null;
};

export type WebhookPayload = {
  event: "email.classified";
  email: {
    id: string;
    thread_id: string | null;
    from_addr: string | null;
    from_name: string | null;
    subject: string | null;
    received_at: string | null;
    folder: { id: string; name: string } | null;
    ai_summary: string | null;
    body_text?: string | null;
  };
  delivery_id: string;
  delivered_at: string;
};

export function buildWebhookPayload(input: {
  email: WebhookEmailFields;
  folder: { id: string; name: string } | null;
  includeBody: boolean;
  deliveryId: string;
  deliveredAt: string;
}): WebhookPayload {
  const e = input.email;
  return {
    event: "email.classified",
    email: {
      id: e.id,
      thread_id: e.thread_id,
      from_addr: e.from_addr,
      from_name: e.from_name,
      subject: e.subject,
      received_at: e.received_at,
      folder: input.folder,
      ai_summary: e.ai_summary,
      ...(input.includeBody ? { body_text: e.body_text ?? null } : {}),
    },
    delivery_id: input.deliveryId,
    delivered_at: input.deliveredAt,
  };
}

/** Deterministic HMAC-SHA256 signature over `${timestamp}.${body}`. */
export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export type DeliverResult =
  { ok: true; status: number } | { ok: false; status: number | null; error: string };

/** POST a signed webhook. Re-validates the URL at send time (config may
 * have been written around the UI), timeboxed, never throws. */
export async function deliverWebhook(input: {
  url: string;
  secret: string | null;
  body: string;
  deliveryId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<DeliverResult> {
  const guard = validateWebhookUrl(input.url);
  if (!guard.ok) return { ok: false, status: null, error: guard.reason };

  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Zerrow-Webhook/1.0",
    "X-Zerrow-Timestamp": timestamp,
    "X-Zerrow-Delivery": input.deliveryId,
  };
  if (input.secret) {
    headers["X-Zerrow-Signature"] =
      `sha256=${signWebhookBody(input.secret, timestamp, input.body)}`;
  }

  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
  try {
    const res = await doFetch(guard.url.toString(), {
      method: "POST",
      headers,
      body: input.body,
      signal: controller.signal,
      redirect: "error",
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: `webhook responded ${res.status}` };
  } catch (e) {
    const msg =
      (e as Error)?.name === "AbortError"
        ? "webhook timed out"
        : ((e as Error)?.message?.slice(0, 300) ?? "unknown");
    return { ok: false, status: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
