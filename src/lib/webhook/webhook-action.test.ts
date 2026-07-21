// Webhook action (rules upgrade, task 5). The contracts protected:
//
//   * the SSRF guard rejects non-https URLs, credentials, localhost, and
//     loopback / RFC1918 / link-local / CGNAT / metadata IP literals —
//     and accepts ordinary public https hosts,
//   * the signature is deterministic HMAC-SHA256 over
//     `${timestamp}.${body}` sent as `X-Zerrow-Signature: sha256=<hex>`,
//   * payloads exclude email bodies unless include_body opted in,
//   * delivery is timeboxed, treats non-2xx as failure, and never throws,
//   * the runner increments attempt via the claim RPC, reschedules failed
//     deliveries with backoff, and fails terminally at attempt 6 (or
//     immediately when the config is gone).

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createHmac } from "crypto";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

const modifyMessage = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../gmail.server", () => ({
  getMessage: async () => ({}),
  parseMessage: () => ({}),
  modifyMessage: (...args: unknown[]) => modifyMessage(...args),
  sendMessage: async () => ({}),
}));

const getEmailsDecrypted = vi.fn();
vi.mock("../sync/encrypted-reader", () => ({
  getEmailsDecrypted: (ids: string[]) => getEmailsDecrypted(ids),
}));

import { validateWebhookUrl, MAX_WEBHOOK_URL_LEN } from "./url-guard";
import { buildWebhookPayload, deliverWebhook, signWebhookBody } from "./deliver";
import { runScheduledActions, SCHEDULED_ACTION_MAX_ATTEMPTS } from "../sync/scheduled-actions";

const savedKey = process.env.EMAIL_ENC_KEY;

beforeEach(() => {
  fake.reset();
  modifyMessage.mockClear();
  getEmailsDecrypted.mockReset();
  process.env.EMAIL_ENC_KEY = "test-enc-key";
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.EMAIL_ENC_KEY;
  else process.env.EMAIL_ENC_KEY = savedKey;
});

describe("url-guard (SSRF)", () => {
  it.each([
    ["http://example.com/hook", "https"],
    ["https://user:pass@example.com/hook", "credentials"],
    ["https://localhost/hook", "localhost"],
    ["https://api.localhost/hook", "localhost"],
    ["https://127.0.0.1/hook", "loopback"],
    ["https://10.1.2.3/hook", "private"],
    ["https://192.168.1.10/hook", "private"],
    ["https://172.16.0.1/hook", "private"],
    ["https://172.31.255.254/hook", "private"],
    ["https://169.254.169.254/latest/meta-data", "link-local"],
    ["https://100.64.0.1/hook", "carrier-grade"],
    ["https://0.0.0.0/hook", "unspecified"],
    ["https://[::1]/hook", "loopback"],
    ["https://[fe80::1]/hook", "link-local"],
    ["https://[fd00::1]/hook", "unique-local"],
    ["https://[::ffff:10.0.0.1]/hook", "mapped"],
    ["not a url", "not a valid URL"],
    ["", "empty"],
  ])("rejects %s", (url, reasonFragment) => {
    const res = validateWebhookUrl(url);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason.toLowerCase()).toContain(reasonFragment.toLowerCase());
  });

  it("rejects URLs over the length bound", () => {
    const res = validateWebhookUrl(`https://example.com/${"a".repeat(MAX_WEBHOOK_URL_LEN)}`);
    expect(res.ok).toBe(false);
  });

  it.each([
    "https://hooks.example.com/zerrow",
    "https://webhook.site/2f3c9a51-0000-4000-8000-000000000000",
    "https://172.32.0.1/hook", // just outside 172.16/12
    "https://11.22.33.44/hook",
  ])("accepts %s", (url) => {
    expect(validateWebhookUrl(url).ok).toBe(true);
  });
});

describe("signature", () => {
  it("is deterministic HMAC-SHA256 over `${timestamp}.${body}`", () => {
    const secret = "whsec_test";
    const ts = "1700000000";
    const body = '{"event":"email.classified"}';
    const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    expect(signWebhookBody(secret, ts, body)).toBe(expected);
    expect(signWebhookBody(secret, ts, body)).toBe(signWebhookBody(secret, ts, body));
    expect(signWebhookBody(secret, "1700000001", body)).not.toBe(expected);
  });
});

describe("payload", () => {
  const email = {
    id: "e1",
    thread_id: "t1",
    from_addr: "a@x.com",
    from_name: "A",
    subject: "Hello",
    received_at: "2026-07-21T00:00:00Z",
    ai_summary: "sum",
    body_text: "SECRET BODY",
  };

  it("excludes body_text unless include_body opted in", () => {
    const closed = buildWebhookPayload({
      email,
      folder: { id: "f1", name: "Invoices" },
      includeBody: false,
      deliveryId: "d1",
      deliveredAt: "2026-07-21T00:00:01Z",
    });
    expect(JSON.stringify(closed)).not.toContain("SECRET BODY");
    expect(closed.email.folder).toEqual({ id: "f1", name: "Invoices" });

    const open = buildWebhookPayload({
      email,
      folder: null,
      includeBody: true,
      deliveryId: "d1",
      deliveredAt: "2026-07-21T00:00:01Z",
    });
    expect(open.email.body_text).toBe("SECRET BODY");
  });
});

describe("deliverWebhook", () => {
  it("POSTs with signature + timestamp headers and treats 2xx as success", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = await deliverWebhook({
      url: "https://hooks.example.com/z",
      secret: "whsec_test",
      body: '{"a":1}',
      deliveryId: "d1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: true, status: 200 });
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe("https://hooks.example.com/z");
    const headers = init.headers as Record<string, string>;
    const ts = headers["X-Zerrow-Timestamp"];
    expect(headers["X-Zerrow-Signature"]).toBe(
      `sha256=${signWebhookBody("whsec_test", ts, '{"a":1}')}`,
    );
    expect(headers["X-Zerrow-Delivery"]).toBe("d1");
    expect(init.redirect).toBe("error");
  });

  it("treats non-2xx as failure and never throws on network errors", async () => {
    const fetch500 = vi.fn(async () => new Response("nope", { status: 500 }));
    const r1 = await deliverWebhook({
      url: "https://hooks.example.com/z",
      secret: null,
      body: "{}",
      deliveryId: "d1",
      fetchImpl: fetch500 as unknown as typeof fetch,
    });
    expect(r1.ok).toBe(false);

    const fetchBoom = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const r2 = await deliverWebhook({
      url: "https://hooks.example.com/z",
      secret: null,
      body: "{}",
      deliveryId: "d1",
      fetchImpl: fetchBoom as unknown as typeof fetch,
    });
    expect(r2).toMatchObject({ ok: false, error: "connection reset" });
  });

  it("refuses SSRF targets at send time", async () => {
    const fetchImpl = vi.fn();
    const res = await deliverWebhook({
      url: "https://169.254.169.254/latest",
      secret: null,
      body: "{}",
      deliveryId: "d1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("runner retry logic", () => {
  function seedJob(attempt: number) {
    fake.onRpc("claim_scheduled_actions", () => ({
      data: [
        {
          id: "job-1",
          user_id: "user-1",
          folder_action_id: "act-1",
          email_id: "e1",
          attempt,
        },
      ],
    }));
    fake.seed("folder_actions", [
      {
        id: "act-1",
        folder_id: "folder-A",
        action_type: "call_webhook",
        label_id: null,
        move_to_folder_id: null,
        enabled: true,
      },
    ]);
    fake.seed("folders", [{ id: "folder-A", name: "Invoices", gmail_label_id: "L-A" }]);
    fake.onRpc("get_folder_action_webhook", () => ({
      data: [
        { webhook_url: "https://hooks.example.com/z", webhook_secret: "s", include_body: false },
      ],
    }));
    getEmailsDecrypted.mockResolvedValue({
      rows: [
        {
          id: "e1",
          user_id: "user-1",
          gmail_account_id: "acc-1",
          gmail_message_id: "gm-1",
          thread_id: "t1",
          from_addr: "a@x.com",
          from_name: "A",
          subject: "Hello",
          received_at: "2026-07-21T00:00:00Z",
          ai_summary: "sum",
          body_text: "body",
          raw_labels: ["INBOX"],
          is_archived: false,
        },
      ],
      error: null,
    });
  }

  function scheduledUpdates() {
    return fake.calls.updates.filter((u) => u.table === "scheduled_actions");
  }

  it("marks done on a successful delivery", async () => {
    seedJob(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    const result = await runScheduledActions(5);
    vi.unstubAllGlobals();
    expect(result).toMatchObject({ claimed: 1, done: 1, retried: 0, failed: 0 });
    expect(scheduledUpdates()[0].payload).toMatchObject({ status: "done" });
  });

  it("reschedules with backoff on failure (attempt below the cap)", async () => {
    seedJob(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 503 })),
    );
    const before = Date.now();
    const result = await runScheduledActions(5);
    vi.unstubAllGlobals();
    expect(result).toMatchObject({ retried: 1 });
    const patch = scheduledUpdates()[0].payload as { status: string; run_at: string };
    expect(patch.status).toBe("pending");
    // attempt 1 → first backoff step (1 minute).
    expect(Date.parse(patch.run_at)).toBeGreaterThanOrEqual(before + 55_000);
  });

  it("fails terminally at the attempt cap", async () => {
    seedJob(SCHEDULED_ACTION_MAX_ATTEMPTS);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 503 })),
    );
    const result = await runScheduledActions(5);
    vi.unstubAllGlobals();
    expect(result).toMatchObject({ failed: 1 });
    expect(scheduledUpdates()[0].payload).toMatchObject({ status: "error" });
  });

  it("fails terminally right away when the action config is gone", async () => {
    fake.onRpc("claim_scheduled_actions", () => ({
      data: [{ id: "job-1", user_id: "u", folder_action_id: "gone", email_id: "e1", attempt: 1 }],
    }));
    getEmailsDecrypted.mockResolvedValue({ rows: [], error: null });
    const result = await runScheduledActions(5);
    expect(result).toMatchObject({ failed: 1 });
    expect(scheduledUpdates()[0].payload).toMatchObject({ status: "error" });
  });

  it("runs a delayed label-type action against fresh email state", async () => {
    fake.onRpc("claim_scheduled_actions", () => ({
      data: [
        { id: "job-2", user_id: "user-1", folder_action_id: "act-2", email_id: "e1", attempt: 1 },
      ],
    }));
    fake.seed("folder_actions", [
      {
        id: "act-2",
        folder_id: "folder-A",
        action_type: "archive",
        label_id: null,
        move_to_folder_id: null,
        enabled: true,
      },
    ]);
    getEmailsDecrypted.mockResolvedValue({
      rows: [
        {
          id: "e1",
          gmail_account_id: "acc-1",
          gmail_message_id: "gm-1",
          raw_labels: ["INBOX"],
          is_archived: false,
        },
      ],
      error: null,
    });
    const result = await runScheduledActions(5);
    expect(result).toMatchObject({ done: 1 });
    expect(modifyMessage).toHaveBeenCalledWith("acc-1", "gm-1", [], ["INBOX"]);
    const emailPatch = fake.calls.updates.find((u) => u.table === "emails");
    expect(emailPatch?.payload).toMatchObject({ is_archived: true });
  });
});

// Live-fire against webhook.site — opt-in only (RUN_LIVE_WEBHOOK=<url>).
describe("live fire", () => {
  it.skipIf(!process.env.RUN_LIVE_WEBHOOK)(
    "delivers a signed payload to webhook.site",
    async () => {
      const res = await deliverWebhook({
        url: process.env.RUN_LIVE_WEBHOOK!,
        secret: "whsec_livefire",
        body: JSON.stringify(
          buildWebhookPayload({
            email: {
              id: "live-1",
              thread_id: null,
              from_addr: "demo@getzerrow.com",
              from_name: "Zerrow Live Fire",
              subject: "Task 5 acceptance test",
              received_at: new Date().toISOString(),
              ai_summary: "Signed webhook delivery test",
            },
            folder: { id: "f-demo", name: "Invoices" },
            includeBody: false,
            deliveryId: "live-fire-1",
            deliveredAt: new Date().toISOString(),
          }),
        ),
        deliveryId: "live-fire-1",
      });
      expect(res.ok).toBe(true);
    },
    30_000,
  );
});
