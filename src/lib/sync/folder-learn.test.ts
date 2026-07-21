// Unit tests for folder-learn — the "learn from the user's labels" lane.
// Contracts:
//
//   recordManualMove — a Gmail label event that merely echoes a label WE
//     applied (row already in the folder via ai/filter/gmail_label/
//     domain_rule/manual_move) must NOT pollute training data; a genuine
//     move appends a manual_move example AND promotes the email row;
//     ≥3 fresh manual-move examples trigger an auto-relearn whose failure
//     is swallowed.
//   regenerateFolderProfile — feeds the 50 newest examples to the AI and
//     persists learned_profile, resetting emails_since_learn to 0.
//   bumpEmailsSinceLearn — atomic RPC first, read-then-write fallback when
//     the RPC is missing, and it NEVER throws (best-effort by contract).
//   loadOlderFromLabel — ownership/label guards, stored-pageToken vs
//     date-anchored before: fallback, and stale-token clearing when a token
//     page yields nothing new.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import type { Folder } from "./types";

const fake = makeSupabaseFake();

// Property accesses are deferred into method bodies so the hoisted factory
// never touches `fake` before its initializer runs.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

const buildFolderProfile = vi.fn();
vi.mock("../ai.server", () => ({
  buildFolderProfile: (...args: unknown[]) => buildFolderProfile(...args),
}));

const listMessages = vi.fn();
const getMessageMetadata = vi.fn();
const parseMessage = vi.fn();
vi.mock("../gmail.server", () => ({
  listMessages: (accountId: string, opts: unknown) => listMessages(accountId, opts),
  getMessageMetadata: (accountId: string, id: string) => getMessageMetadata(accountId, id),
  parseMessage: (raw: unknown) => parseMessage(raw),
}));

const logError = vi.fn();
vi.mock("../log.server", () => ({
  logError: (...args: unknown[]) => logError(...args),
  logInfo: () => {},
}));

const insertFolderExampleEncrypted = vi.fn();
const upsertEmailEncrypted = vi.fn();
const updateEmailEncrypted = vi.fn();
vi.mock("./encrypted-writer", () => ({
  insertFolderExampleEncrypted: (input: unknown) => insertFolderExampleEncrypted(input),
  upsertEmailEncrypted: (input: unknown) => upsertEmailEncrypted(input),
  updateEmailEncrypted: (input: unknown) => updateEmailEncrypted(input),
}));

import {
  recordManualMove,
  regenerateFolderProfile,
  bumpEmailsSinceLearn,
  loadOlderFromLabel,
} from "./folder-learn";

const USER = "user-1";
const ACC = "acc-1";
const FOLDER_ID = "folder-1";

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: FOLDER_ID,
    name: "Receipts",
    gmail_label_id: "L-1",
    ai_rule: "receipts and invoices",
    learned_profile: null,
    last_learned_at: "2026-01-01T00:00:00Z",
    auto_archive: false,
    auto_mark_read: false,
    auto_star: false,
    hide_from_inbox: false,
    skip_ai: false,
    priority: 0,
    gmail_account_id: ACC,
    filter_logic: "any",
    filter_tree: null,
    forward_to: null,
    min_ai_confidence: 0,
    snooze_hours: 0,
    overrides_inbox_override: false,
    is_cold_email: false,
    surface_ai_rule: null,
    surface_names: null,
    ...overrides,
  };
}

const MOVE_MSG = {
  gmail_message_id: "gm-1",
  from_addr: "shop@x.com",
  subject: "Your receipt",
  snippet: "Thanks for your order",
};

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  insertFolderExampleEncrypted.mockResolvedValue({ id: "ex-1", error: null });
  upsertEmailEncrypted.mockResolvedValue({ id: "new-1", error: null });
  updateEmailEncrypted.mockResolvedValue({ error: null });
  buildFolderProfile.mockResolvedValue("PROFILE");
  listMessages.mockResolvedValue({ messages: [] });
});

describe("recordManualMove — echo suppression", () => {
  it("does nothing when the row is already in the folder via a non-manual classification", async () => {
    fake.seed("emails", [
      {
        id: "e1",
        gmail_message_id: "gm-1",
        gmail_account_id: ACC,
        folder_id: FOLDER_ID,
        classified_by: "ai",
      },
    ]);
    await recordManualMove(makeFolder(), ACC, USER, MOVE_MSG);
    // No training example, no promotion, no relearn probe.
    expect(insertFolderExampleEncrypted).not.toHaveBeenCalled();
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
    expect(buildFolderProfile).not.toHaveBeenCalled();
  });

  it("a repeated manual_move echo is also suppressed", async () => {
    fake.seed("emails", [
      {
        id: "e1",
        gmail_message_id: "gm-1",
        gmail_account_id: ACC,
        folder_id: FOLDER_ID,
        classified_by: "manual_move",
      },
    ]);
    await recordManualMove(makeFolder(), ACC, USER, MOVE_MSG);
    expect(insertFolderExampleEncrypted).not.toHaveBeenCalled();
  });
});

describe("recordManualMove — genuine move", () => {
  it("appends a manual_move example and promotes the email row", async () => {
    fake.seed("emails", [
      {
        id: "e1",
        gmail_message_id: "gm-1",
        gmail_account_id: ACC,
        folder_id: "other-folder",
        classified_by: "ai",
      },
    ]);
    await recordManualMove(makeFolder(), ACC, USER, MOVE_MSG);

    expect(insertFolderExampleEncrypted).toHaveBeenCalledWith({
      folder_id: FOLDER_ID,
      gmail_account_id: ACC,
      user_id: USER,
      gmail_message_id: "gm-1",
      from_addr: "shop@x.com",
      subject: "Your receipt",
      snippet: "Thanks for your order",
      source: "manual_move",
    });
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: "e1",
      folder_id: FOLDER_ID,
      classified_by: "manual_move",
      ai_confidence: 1,
      classification_reason: 'Moved to "Receipts" manually in Gmail',
    });
  });

  it("still records the example when no local email row exists (no promotion)", async () => {
    await recordManualMove(makeFolder(), ACC, USER, MOVE_MSG);
    expect(insertFolderExampleEncrypted).toHaveBeenCalledTimes(1);
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
  });

  it("triggers auto-relearn at ≥3 fresh manual_move examples since last_learned_at", async () => {
    // 3 qualifying examples + one wrong-source + one stale — count must be 3.
    fake.seed("folder_examples", [
      { id: "x1", folder_id: FOLDER_ID, source: "manual_move", created_at: "2026-06-01T00:00:00Z" },
      { id: "x2", folder_id: FOLDER_ID, source: "manual_move", created_at: "2026-06-02T00:00:00Z" },
      { id: "x3", folder_id: FOLDER_ID, source: "manual_move", created_at: "2026-06-03T00:00:00Z" },
      { id: "x4", folder_id: FOLDER_ID, source: "seed", created_at: "2026-06-04T00:00:00Z" },
      { id: "x5", folder_id: FOLDER_ID, source: "manual_move", created_at: "2025-06-01T00:00:00Z" },
    ]);
    fake.seed("folders", [
      { id: FOLDER_ID, name: "Receipts", ai_rule: "receipts", emails_since_learn: 5 },
    ]);
    await recordManualMove(makeFolder(), ACC, USER, MOVE_MSG);

    expect(buildFolderProfile).toHaveBeenCalledTimes(1);
    const folderUpdates = fake.calls.updates.filter((u) => u.table === "folders");
    expect(folderUpdates).toHaveLength(1);
    expect(folderUpdates[0].payload).toMatchObject({
      learned_profile: "PROFILE",
      emails_since_learn: 0,
    });
  });

  it("stays below the relearn threshold with only 2 fresh examples", async () => {
    fake.seed("folder_examples", [
      { id: "x1", folder_id: FOLDER_ID, source: "manual_move", created_at: "2026-06-01T00:00:00Z" },
      { id: "x2", folder_id: FOLDER_ID, source: "manual_move", created_at: "2026-06-02T00:00:00Z" },
    ]);
    await recordManualMove(makeFolder(), ACC, USER, MOVE_MSG);
    expect(buildFolderProfile).not.toHaveBeenCalled();
  });

  it("swallows an auto-relearn failure (logged, never thrown)", async () => {
    fake.seed("folder_examples", [
      { id: "x1", folder_id: FOLDER_ID, source: "manual_move", created_at: "2026-06-01T00:00:00Z" },
      { id: "x2", folder_id: FOLDER_ID, source: "manual_move", created_at: "2026-06-02T00:00:00Z" },
      { id: "x3", folder_id: FOLDER_ID, source: "manual_move", created_at: "2026-06-03T00:00:00Z" },
    ]);
    fake.seed("folders", [{ id: FOLDER_ID, name: "Receipts", ai_rule: null }]);
    buildFolderProfile.mockRejectedValueOnce(new Error("AI gateway down"));

    await expect(recordManualMove(makeFolder(), ACC, USER, MOVE_MSG)).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(
      "folder_learn.auto_relearn_failed",
      { folder_id: FOLDER_ID },
      expect.any(Error),
    );
  });
});

describe("regenerateFolderProfile", () => {
  it("returns undefined without calling the AI when the folder is missing", async () => {
    const out = await regenerateFolderProfile("nope");
    expect(out).toBeUndefined();
    expect(buildFolderProfile).not.toHaveBeenCalled();
    expect(fake.calls.updates).toHaveLength(0);
  });

  it("feeds newest-first examples to the AI and persists the profile with a reset counter", async () => {
    fake.seed("folders", [{ id: FOLDER_ID, name: "Receipts", ai_rule: "receipts" }]);
    fake.seed("folder_examples", [
      { id: "x1", folder_id: FOLDER_ID, from_addr: "a@x.com", created_at: "2026-06-01T00:00:00Z" },
      { id: "x2", folder_id: FOLDER_ID, from_addr: "b@x.com", created_at: "2026-06-02T00:00:00Z" },
    ]);

    const out = await regenerateFolderProfile(FOLDER_ID);
    expect(out).toBe("PROFILE");
    expect(buildFolderProfile).toHaveBeenCalledWith("Receipts", "receipts", [
      { from_addr: "b@x.com", subject: null, snippet: null },
      { from_addr: "a@x.com", subject: null, snippet: null },
    ]);

    const folderUpdates = fake.calls.updates.filter((u) => u.table === "folders");
    expect(folderUpdates).toHaveLength(1);
    expect(folderUpdates[0].payload).toMatchObject({
      learned_profile: "PROFILE",
      emails_since_learn: 0,
    });
    expect(folderUpdates[0].payload).toHaveProperty("last_learned_at");
    expect(folderUpdates[0].filters).toEqual([{ op: "eq", col: "id", value: FOLDER_ID }]);
  });
});

describe("bumpEmailsSinceLearn", () => {
  it("uses the atomic RPC and skips the fallback when it succeeds", async () => {
    fake.onRpc("increment_emails_since_learn", () => null);
    await bumpEmailsSinceLearn(FOLDER_ID);
    expect(fake.calls.rpcs).toEqual([
      { fn: "increment_emails_since_learn", args: { p_folder_id: FOLDER_ID } },
    ]);
    expect(fake.calls.selects).toHaveLength(0);
    expect(fake.calls.updates).toHaveLength(0);
  });

  it("falls back to read-then-write when the RPC errors", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.onRpc("increment_emails_since_learn", () => ({
      error: { message: "function does not exist" },
    }));
    fake.seed("folders", [{ id: FOLDER_ID, emails_since_learn: 4 }]);

    await bumpEmailsSinceLearn(FOLDER_ID);
    const folderUpdates = fake.calls.updates.filter((u) => u.table === "folders");
    expect(folderUpdates).toHaveLength(1);
    expect(folderUpdates[0].payload).toEqual({ emails_since_learn: 5 });
    errSpy.mockRestore();
  });

  it("never throws — a hard failure is logged and swallowed", async () => {
    fake.onRpc("increment_emails_since_learn", () => {
      throw new Error("network down");
    });
    await expect(bumpEmailsSinceLearn(FOLDER_ID)).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(
      "folder_learn.bump_failed",
      { folder_id: FOLDER_ID },
      expect.any(Error),
    );
  });
});

describe("loadOlderFromLabel", () => {
  function seedFolderRow(overrides: Record<string, unknown> = {}) {
    fake.seed("folders", [
      {
        id: FOLDER_ID,
        user_id: USER,
        name: "Receipts",
        gmail_label_id: "L-1",
        gmail_account_id: ACC,
        gmail_backfill_page_token: null,
        gmail_backfill_oldest_received_at: null,
        ...overrides,
      },
    ]);
  }

  it("throws Folder not found / Not authorized, and short-circuits without a label", async () => {
    await expect(loadOlderFromLabel("nope", USER, null)).rejects.toThrow("Folder not found");

    seedFolderRow({ user_id: "someone-else" });
    await expect(loadOlderFromLabel(FOLDER_ID, USER, null)).rejects.toThrow("Not authorized");

    fake.reset();
    seedFolderRow({ gmail_label_id: null });
    await expect(loadOlderFromLabel(FOLDER_ID, USER, null)).resolves.toEqual({
      ingested: 0,
      hasMore: false,
      reason: "no_label",
    });
    expect(listMessages).not.toHaveBeenCalled();
  });

  it("uses the stored pageToken when the cursor is at/behind the oldest backfilled row", async () => {
    seedFolderRow({
      gmail_backfill_page_token: "tok-1",
      gmail_backfill_oldest_received_at: "2026-05-01T00:00:00Z",
    });
    listMessages.mockResolvedValueOnce({ messages: [] });

    await loadOlderFromLabel(FOLDER_ID, USER, "2026-04-01T00:00:00Z");
    expect(listMessages).toHaveBeenCalledWith(ACC, {
      labelIds: ["L-1"],
      maxResults: 50,
      pageToken: "tok-1",
      q: undefined,
    });
  });

  it("falls back to a date-anchored before: query when the token does not apply, and claims known rows", async () => {
    seedFolderRow({
      gmail_backfill_page_token: "tok-1",
      gmail_backfill_oldest_received_at: "2026-05-01T00:00:00Z",
    });
    // Cursor is NEWER than the oldest backfilled row → token unusable.
    const before = "2026-06-01T00:00:00Z";
    listMessages.mockResolvedValueOnce({ messages: [{ id: "gm-k" }] });
    fake.seed("emails", [
      {
        id: "e-k",
        gmail_message_id: "gm-k",
        folder_id: "other",
        received_at: "2026-03-01T00:00:00Z",
      },
    ]);

    const res = await loadOlderFromLabel(FOLDER_ID, USER, before);
    expect(listMessages).toHaveBeenCalledWith(ACC, {
      labelIds: ["L-1"],
      maxResults: 50,
      pageToken: undefined,
      q: `before:${Math.floor(new Date(before).getTime() / 1000)}`,
    });
    // Known row in another folder gets claimed via the encrypted writer.
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: "e-k",
      folder_id: FOLDER_ID,
      classified_by: "gmail_label",
      ai_confidence: 1,
      classification_reason: 'Matched Gmail label "Receipts"',
    });
    expect(res).toEqual({ ingested: 0, claimed: 1, hasMore: false });
  });

  it("ingests unknown messages via metadata fetch and stamps the folder on the new row", async () => {
    seedFolderRow();
    listMessages.mockResolvedValueOnce({ messages: [{ id: "gm-new" }] });
    getMessageMetadata.mockResolvedValueOnce({ raw: true });
    parseMessage.mockReturnValueOnce({
      gmail_message_id: "gm-new",
      thread_id: "t-new",
      from_addr: "shop@x.com",
      from_name: "Shop",
      to_addrs: "me@x.com",
      subject: "Old receipt",
      snippet: "snip",
      received_at: "2026-02-01T00:00:00Z",
      is_read: true,
      has_attachment: false,
      raw_labels: ["L-1"],
    });

    const res = await loadOlderFromLabel(FOLDER_ID, USER, null);
    expect(res).toEqual({ ingested: 1, claimed: 0, hasMore: false });
    expect(upsertEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({
        gmail_message_id: "gm-new",
        classified_by: "gmail_label",
        is_archived: true,
        body_text: null,
        body_html: null,
      }),
    );
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: "new-1",
      folder_id: FOLDER_ID,
      ai_confidence: 1,
      classification_reason: 'Matched Gmail label "Receipts"',
    });
    // The oldest received_at we saw becomes the new backfill anchor.
    const folderUpdates = fake.calls.updates.filter((u) => u.table === "folders");
    expect(folderUpdates[0].payload).toEqual({
      gmail_backfill_page_token: null,
      gmail_backfill_oldest_received_at: "2026-02-01T00:00:00Z",
    });
  });

  it("clears a stale pageToken when the token page yields nothing new", async () => {
    seedFolderRow({
      gmail_backfill_page_token: "tok-stale",
      gmail_backfill_oldest_received_at: "2026-05-01T00:00:00Z",
    });
    // Token used, Gmail returns a page of messages we already have IN this
    // folder (nothing ingested, nothing claimed) plus a next token.
    listMessages.mockResolvedValueOnce({
      messages: [{ id: "gm-k" }],
      nextPageToken: "tok-next",
    });
    fake.seed("emails", [
      {
        id: "e-k",
        gmail_message_id: "gm-k",
        folder_id: FOLDER_ID,
        received_at: "2026-03-01T00:00:00Z",
      },
    ]);

    const res = await loadOlderFromLabel(FOLDER_ID, USER, "2026-04-01T00:00:00Z");
    // hasMore reflects Gmail's token, but the STORED token is cleared so the
    // next click falls through to the date-anchored query path.
    expect(res).toEqual({ ingested: 0, claimed: 0, hasMore: true });
    const folderUpdates = fake.calls.updates.filter((u) => u.table === "folders");
    expect(folderUpdates).toHaveLength(1);
    expect(folderUpdates[0].payload).toEqual({
      gmail_backfill_page_token: null,
      gmail_backfill_oldest_received_at: "2026-03-01T00:00:00Z",
    });
  });
});
