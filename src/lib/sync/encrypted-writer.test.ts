// Unit tests for the encrypt-RPC wrappers — the write side of the encryption
// boundary. The highest-value contracts:
//
//   * exact RPC name + p_* argument mapping (including p_key from env),
//   * updateEmailEncrypted sends omitted optional fields as null — the RPC
//     treats null as "leave unchanged", so a regression here wipes columns,
//   * insertFolderExampleEncrypted's retry engine: retries resend the SAME
//     natural key (folder_id, gmail_message_id) so a committed-but-errored
//     write upserts in place; retry/failure bookkeeping inserts are
//     best-effort and must never mask the real write result.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

// Property accesses are deferred into method bodies so the hoisted factory
// never touches `fake` before its initializer runs.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

const logErrorCalls: Array<{ event: string }> = [];
vi.mock("@/lib/log.server", () => ({
  logError: (event: string) => {
    logErrorCalls.push({ event });
  },
  logInfo: () => {},
  logMetric: () => {},
}));

// Retry policy is fully controlled: 3 attempts, no real sleeping, and
// transiency decided per-test via `transientResult`.
let transientResult = false;
vi.mock("@/lib/folder-write-retry", () => ({
  resolveRetryConfig: () => ({ maxAttempts: 3, baseMs: 0 }),
  isTransientWriteError: () => transientResult,
  backoffDelayMs: () => 0,
  sleep: async () => {},
}));

import {
  insertFolderExampleEncrypted,
  setContactEncryptedFields,
  setReplyDraftEncrypted,
  updateEmailEncrypted,
  upsertEmailEncrypted,
} from "./encrypted-writer";

const KEY = "test-enc-key";
const savedKey = process.env.EMAIL_ENC_KEY;

const exampleInput = {
  user_id: "user-1",
  gmail_account_id: "acc-1",
  folder_id: "folder-1",
  gmail_message_id: "msg-1",
  from_addr: "a@x.com",
  subject: "subj",
  snippet: "snip",
};

beforeEach(() => {
  fake.reset();
  logErrorCalls.length = 0;
  transientResult = false;
  process.env.EMAIL_ENC_KEY = KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.EMAIL_ENC_KEY;
  else process.env.EMAIL_ENC_KEY = savedKey;
});

describe("upsertEmailEncrypted", () => {
  const input = {
    user_id: "user-1",
    gmail_account_id: "acc-1",
    gmail_message_id: "msg-1",
    thread_id: "t-1",
    from_addr: "a@x.com",
    from_name: "A",
    to_addrs: "b@x.com",
    cc: null,
    list_id: null,
    in_reply_to: null,
    subject: "hello",
    snippet: "snip",
    body_text: "body",
    body_html: "<p>body</p>",
    received_at: "2026-07-01T00:00:00Z",
    is_read: false,
    is_archived: true,
    has_attachment: false,
    raw_labels: ["INBOX"],
    classified_by: "filter",
    processed_at: "2026-07-01T00:00:01Z",
    published_at_ms: 123,
  };

  it("maps every input field to its p_* RPC argument including p_key", async () => {
    fake.onRpc("upsert_email_encrypted", () => "email-id-1");
    const res = await upsertEmailEncrypted(input);
    expect(res).toEqual({ id: "email-id-1", error: null });
    expect(fake.calls.rpcs).toEqual([
      {
        fn: "upsert_email_encrypted",
        args: {
          p_user_id: "user-1",
          p_gmail_account_id: "acc-1",
          p_gmail_message_id: "msg-1",
          p_thread_id: "t-1",
          p_from_addr: "a@x.com",
          p_from_name: "A",
          p_to_addrs: "b@x.com",
          p_cc: null,
          p_list_id: null,
          p_in_reply_to: null,
          p_subject: "hello",
          p_snippet: "snip",
          p_body_text: "body",
          p_body_html: "<p>body</p>",
          p_received_at: "2026-07-01T00:00:00Z",
          p_is_read: false,
          p_is_archived: true,
          p_has_attachment: false,
          p_raw_labels: ["INBOX"],
          p_classified_by: "filter",
          p_processed_at: "2026-07-01T00:00:01Z",
          p_published_at_ms: 123,
          p_key: KEY,
        },
      },
    ]);
  });

  it("returns { id: null, error } on RPC error and null id on null data", async () => {
    fake.onRpc("upsert_email_encrypted", () => ({ error: { message: "insert failed" } }));
    expect(await upsertEmailEncrypted(input)).toEqual({ id: null, error: "insert failed" });

    fake.onRpc("upsert_email_encrypted", () => null);
    expect(await upsertEmailEncrypted(input)).toEqual({ id: null, error: null });
  });
});

describe("updateEmailEncrypted", () => {
  it("sends omitted optional fields as null (leave-unchanged contract)", async () => {
    await updateEmailEncrypted({ email_id: "e-1", folder_id: "f-1", classified_by: "ai" });
    expect(fake.calls.rpcs).toEqual([
      {
        fn: "update_email_encrypted",
        args: {
          p_email_id: "e-1",
          p_subject: null,
          p_snippet: null,
          p_body_text: null,
          p_body_html: null,
          p_ai_summary: null,
          p_classification_reason: null,
          p_from_name: null,
          p_to_addrs: null,
          p_folder_id: "f-1",
          p_ai_confidence: null,
          p_classified_by: "ai",
          p_matched_filter_ids: null,
          p_matched_folder_ids: null,
          p_key: KEY,
        },
      },
    ]);
  });

  it("propagates the RPC error message", async () => {
    fake.onRpc("update_email_encrypted", () => ({ error: { message: "update failed" } }));
    expect(await updateEmailEncrypted({ email_id: "e-1" })).toEqual({ error: "update failed" });
  });
});

describe("setReplyDraftEncrypted / setContactEncryptedFields", () => {
  it("setReplyDraftEncrypted maps args and returns the RPC id", async () => {
    fake.onRpc("set_reply_draft_encrypted", () => "draft-1");
    const res = await setReplyDraftEncrypted({
      user_id: "user-1",
      email_id: "e-1",
      draft_text: "hi there",
    });
    expect(res).toEqual({ id: "draft-1", error: null });
    expect(fake.calls.rpcs).toEqual([
      {
        fn: "set_reply_draft_encrypted",
        args: { p_user_id: "user-1", p_email_id: "e-1", p_draft_text: "hi there", p_key: KEY },
      },
    ]);
  });

  it("setContactEncryptedFields nulls omitted fields and propagates errors", async () => {
    await setContactEncryptedFields({ contact_id: "c-1", notes: "note" });
    expect(fake.calls.rpcs).toEqual([
      {
        fn: "set_contact_encrypted_fields",
        args: {
          p_contact_id: "c-1",
          p_notes: "note",
          p_relationship_summary: null,
          p_address_line1: null,
          p_address_line2: null,
          p_phone: null,
          p_key: KEY,
        },
      },
    ]);

    fake.onRpc("set_contact_encrypted_fields", () => ({ error: { message: "enc failed" } }));
    expect(await setContactEncryptedFields({ contact_id: "c-1" })).toEqual({
      error: "enc failed",
    });
  });
});

describe("EMAIL_ENC_KEY guard", () => {
  it("rejects before any RPC when the key is unset", async () => {
    delete process.env.EMAIL_ENC_KEY;
    await expect(updateEmailEncrypted({ email_id: "e-1", subject: "s" })).rejects.toThrow(
      "EMAIL_ENC_KEY not configured",
    );
    await expect(insertFolderExampleEncrypted(exampleInput)).rejects.toThrow(
      "EMAIL_ENC_KEY not configured",
    );
    expect(fake.calls.rpcs).toHaveLength(0);
  });
});

describe("insertFolderExampleEncrypted retry engine", () => {
  function scriptResults(
    results: Array<{ data?: unknown; error?: { message: string; code?: string } }>,
  ) {
    const queue = [...results];
    fake.onRpc("insert_folder_example_encrypted", () => {
      const next = queue.shift();
      if (!next) throw new Error("unexpected extra RPC attempt");
      return { data: next.data ?? null, error: next.error ?? null };
    });
  }

  it("first-attempt success: one RPC, source defaults to seed, no bookkeeping inserts", async () => {
    scriptResults([{ data: "ex-1" }]);
    const res = await insertFolderExampleEncrypted(exampleInput);
    expect(res).toEqual({ id: "ex-1", error: null });
    expect(fake.calls.rpcs).toHaveLength(1);
    expect(fake.calls.rpcs[0].args).toMatchObject({
      p_user_id: "user-1",
      p_gmail_account_id: "acc-1",
      p_folder_id: "folder-1",
      p_gmail_message_id: "msg-1",
      p_from_addr: "a@x.com",
      p_subject: "subj",
      p_snippet: "snip",
      p_source: "seed",
      p_key: KEY,
    });
    expect(fake.calls.inserts).toHaveLength(0);
  });

  it("transient error then success: retry resends the identical natural key", async () => {
    transientResult = true;
    scriptResults([{ error: { message: "connection reset", code: "08006" } }, { data: "ex-2" }]);
    const res = await insertFolderExampleEncrypted({ ...exampleInput, source: "manual_move" });
    expect(res).toEqual({ id: "ex-2", error: null });

    expect(fake.calls.rpcs).toHaveLength(2);
    // Idempotency invariant: both attempts carry the same
    // (folder_id, gmail_message_id) natural key and full payload.
    expect(fake.calls.rpcs[1].args).toEqual(fake.calls.rpcs[0].args);
    expect(fake.calls.rpcs[0].args).toMatchObject({
      p_folder_id: "folder-1",
      p_gmail_message_id: "msg-1",
      p_source: "manual_move",
    });

    const retryRecords = fake.calls.inserts.filter((i) => i.table === "folder_write_retries");
    expect(retryRecords).toHaveLength(1);
    expect(retryRecords[0].payload).toMatchObject({
      user_id: "user-1",
      folder_id: "folder-1",
      attempts: 2,
      outcome: "success",
      error_code: null,
      source: "manual_move",
    });
    expect(fake.calls.inserts.filter((i) => i.table === "folder_write_failures")).toHaveLength(0);
  });

  it("non-transient error: no retry, failure recorded with the pg error code", async () => {
    transientResult = false;
    scriptResults([{ error: { message: "column does not exist", code: "42703" } }]);
    const res = await insertFolderExampleEncrypted(exampleInput);
    expect(res).toEqual({ id: null, error: "column does not exist" });
    expect(fake.calls.rpcs).toHaveLength(1);

    const failures = fake.calls.inserts.filter((i) => i.table === "folder_write_failures");
    expect(failures).toHaveLength(1);
    expect(failures[0].payload).toMatchObject({
      user_id: "user-1",
      folder_id: "folder-1",
      error_code: "42703",
      source: "seed",
    });
    // Attempt count is 1 → no retry record.
    expect(fake.calls.inserts.filter((i) => i.table === "folder_write_retries")).toHaveLength(0);
  });

  it("persistent transient error: exhausts maxAttempts, records retry failure + failure row", async () => {
    transientResult = true;
    const err = { message: "timeout", code: "57014" };
    scriptResults([{ error: err }, { error: err }, { error: err }]);
    const res = await insertFolderExampleEncrypted(exampleInput);
    expect(res).toEqual({ id: null, error: "timeout" });
    expect(fake.calls.rpcs).toHaveLength(3);

    const retryRecords = fake.calls.inserts.filter((i) => i.table === "folder_write_retries");
    expect(retryRecords).toHaveLength(1);
    expect(retryRecords[0].payload).toMatchObject({
      attempts: 3,
      outcome: "failure",
      error_code: "57014",
    });
    expect(fake.calls.inserts.filter((i) => i.table === "folder_write_failures")).toHaveLength(1);
  });

  it("a throwing retry-record insert never masks a successful write", async () => {
    transientResult = true;
    scriptResults([{ error: { message: "flake", code: "08006" } }, { data: "ex-3" }]);
    fake.onInsert("folder_write_retries", () => {
      throw new Error("retries table unavailable");
    });
    const res = await insertFolderExampleEncrypted(exampleInput);
    expect(res).toEqual({ id: "ex-3", error: null });
    expect(logErrorCalls.some((c) => c.event === "folder_write_retry.record_failed")).toBe(true);
  });

  it("a throwing failure-record insert never masks the original error", async () => {
    transientResult = false;
    scriptResults([{ error: { message: "real failure", code: "23505" } }]);
    fake.onInsert("folder_write_failures", () => {
      throw new Error("failures table unavailable");
    });
    const res = await insertFolderExampleEncrypted(exampleInput);
    expect(res).toEqual({ id: null, error: "real failure" });
    expect(logErrorCalls.some((c) => c.event === "folder_write_failure.record_failed")).toBe(true);
  });
});
