// loadThreadEmailsForClassify — the bounded prior-message window that
// run_on_threads folders evaluate against.
//
// It runs on the classify hot path for every arriving message once ANY
// folder opts into thread scope, so the bounds are the contract: at most
// THREAD_CONTEXT_LIMIT prior messages, each body truncated, the incoming
// message excluded, and any failure degrading to "no thread context"
// rather than blocking ingest.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const logError = vi.fn();
vi.mock("@/lib/log.server", () => ({
  logError: (...args: unknown[]) => logError(...args),
  logInfo: () => {},
}));

import {
  loadThreadEmailsForClassify,
  threadScopeEnabled,
  THREAD_BODY_TRUNCATE,
  THREAD_CONTEXT_LIMIT,
} from "./thread-context";
import { makeAccountContext } from "./__fixtures__/account-context";
import { makeFolder } from "@/lib/__fixtures__/email-row";

const ACC = "acc-1";
const THREAD = "thread-1";
const INCOMING = "gm-incoming";

/** Seed `n` prior messages plus the incoming one, newest first. */
function seedThread(n: number, over: Record<string, unknown> = {}) {
  fake.seed("emails", [
    {
      id: "e-incoming",
      gmail_account_id: ACC,
      thread_id: THREAD,
      gmail_message_id: INCOMING,
      received_at: "2026-09-02T00:00:00.000Z",
    },
    ...Array.from({ length: n }, (_, i) => ({
      id: `e-${i}`,
      gmail_account_id: ACC,
      thread_id: THREAD,
      gmail_message_id: `gm-${i}`,
      // Descending so the newest prior message sorts first.
      received_at: `2026-09-01T00:${String(59 - i).padStart(2, "0")}:00.000Z`,
      ...over,
    })),
  ]);
}

/** Resolve get_emails_decrypted with one plaintext row per requested id. */
function decryptAs(row: (id: string) => Record<string, unknown>) {
  fake.onRpc("get_emails_decrypted", (args) =>
    (args["p_ids"] as string[]).map((id) => ({
      id,
      from_addr: null,
      from_name: null,
      to_addrs: null,
      cc: null,
      list_id: null,
      in_reply_to: null,
      subject: null,
      body_text: null,
      has_attachment: false,
      ...row(id),
    })),
  );
}

beforeEach(() => {
  fake.reset();
  logError.mockReset();
  vi.stubEnv("EMAIL_ENC_KEY", "test-key");
});

describe("threadScopeEnabled", () => {
  it("is false until a folder opts in, so callers can skip the fetch entirely", () => {
    const off = makeAccountContext({ folders: [makeFolder({ id: "f1" })] });
    expect(threadScopeEnabled(off)).toBe(false);

    const on = makeAccountContext({
      folders: [makeFolder({ id: "f1" }), makeFolder({ id: "f2", run_on_threads: true })],
    });
    expect(threadScopeEnabled(on)).toBe(true);
  });
});

describe("loadThreadEmailsForClassify", () => {
  it("returns nothing, and reads nothing, for a message with no thread", async () => {
    expect(await loadThreadEmailsForClassify(ACC, null, INCOMING)).toEqual([]);
    expect(await loadThreadEmailsForClassify(ACC, "", INCOMING)).toEqual([]);
    expect(fake.calls.selects).toEqual([]);
  });

  it("excludes the message being classified from its own thread context", async () => {
    seedThread(2);
    decryptAs((id) => ({ subject: `subject ${id}` }));

    const rows = await loadThreadEmailsForClassify(ACC, THREAD, INCOMING);
    expect(rows.map((r) => r.subject)).toEqual(["subject e-0", "subject e-1"]);
  });

  it("returns nothing when the thread holds only the message being classified", async () => {
    seedThread(0);
    decryptAs(() => ({}));
    expect(await loadThreadEmailsForClassify(ACC, THREAD, INCOMING)).toEqual([]);
    // No decrypt round trip for an empty id list.
    expect(fake.calls.rpcs).toEqual([]);
  });

  it("caps the window at THREAD_CONTEXT_LIMIT prior messages, newest first", async () => {
    seedThread(15);
    decryptAs((id) => ({ subject: id }));

    const rows = await loadThreadEmailsForClassify(ACC, THREAD, INCOMING);
    expect(rows).toHaveLength(THREAD_CONTEXT_LIMIT);
    expect(rows[0]!.subject).toBe("e-0");
    expect(rows.at(-1)!.subject).toBe(`e-${THREAD_CONTEXT_LIMIT - 1}`);
  });

  it("fetches one extra row, so the incoming message being newest cannot shorten the window", async () => {
    // seedThread stamps the incoming message as the NEWEST in the thread,
    // so it occupies the first slot of the raw read. With exactly
    // THREAD_CONTEXT_LIMIT priors behind it, a limit of THREAD_CONTEXT_LIMIT
    // would return only 9 of them.
    seedThread(THREAD_CONTEXT_LIMIT);
    decryptAs((id) => ({ subject: id }));

    const rows = await loadThreadEmailsForClassify(ACC, THREAD, INCOMING);
    expect(rows).toHaveLength(THREAD_CONTEXT_LIMIT);
  });

  it("scopes the thread read to the account, never across tenants", async () => {
    seedThread(1);
    decryptAs(() => ({}));
    await loadThreadEmailsForClassify(ACC, THREAD, INCOMING);
    expect(fake.calls.selects[0]!.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "gmail_account_id", value: ACC },
        { op: "eq", col: "thread_id", value: THREAD },
      ]),
    );
  });

  it("truncates each body to the filter engine's regex input cap", async () => {
    seedThread(1);
    decryptAs(() => ({ body_text: "x".repeat(THREAD_BODY_TRUNCATE + 500) }));

    const rows = await loadThreadEmailsForClassify(ACC, THREAD, INCOMING);
    expect(rows[0]!.body_text).toHaveLength(THREAD_BODY_TRUNCATE);
  });

  it("maps a fully-null decrypted row onto the filter engine's shape without undefined strings", async () => {
    seedThread(1);
    decryptAs(() => ({}));

    const rows = await loadThreadEmailsForClassify(ACC, THREAD, INCOMING);
    expect(rows[0]).toStrictEqual({
      from_addr: "",
      from_name: "",
      to_addrs: "",
      cc: undefined,
      list_id: undefined,
      in_reply_to: undefined,
      subject: "",
      body_text: "",
      has_attachment: false,
    });
  });

  it("degrades to no thread context when the id read fails, and says so in the log", async () => {
    seedThread(2);
    decryptAs(() => ({}));
    fake.onSelect("emails", () => ({ message: "connection reset" }));

    expect(await loadThreadEmailsForClassify(ACC, THREAD, INCOMING)).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "thread_context.load_failed",
      { gmail_account_id: ACC, thread_id: THREAD },
      expect.any(Error),
    );
  });

  it("degrades to no thread context when the decrypt RPC fails", async () => {
    seedThread(2);
    fake.onRpc("get_emails_decrypted", () => ({ error: { message: "bad key" } }));

    expect(await loadThreadEmailsForClassify(ACC, THREAD, INCOMING)).toEqual([]);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("degrades to no thread context when the decrypt RPC throws", async () => {
    seedThread(2);
    fake.onRpc("get_emails_decrypted", () => {
      throw new Error("network down");
    });

    expect(await loadThreadEmailsForClassify(ACC, THREAD, INCOMING)).toEqual([]);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
