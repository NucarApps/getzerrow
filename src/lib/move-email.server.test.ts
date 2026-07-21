// Unit tests for performMove — the shared destructive core behind every
// "move email to folder" entry point. It mutates the local row, strips
// INBOX in the user's real Gmail, and rewrites folder training examples,
// so the ordering contracts matter:
//
//   * ownership is checked before ANY mutation,
//   * the encrypted write goes first and aborts the move on failure,
//   * a Gmail label-sync failure is swallowed — the local move still wins,
//   * training examples move with the email (delete old, insert correction).

import { describe, it, expect, beforeEach, vi } from "vitest";
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

const modifyMessage = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("./gmail.server", () => ({
  modifyMessage: (...args: unknown[]) => modifyMessage(...args),
}));

vi.mock("./log.server", () => ({
  logError: () => {},
  logInfo: () => {},
}));

const updateEmailEncrypted = vi.fn(async (_input: unknown) => ({ error: null as string | null }));
const insertFolderExampleEncrypted = vi.fn(async (_input: unknown) => ({
  id: "ex-1",
  error: null,
}));
vi.mock("./sync/encrypted-writer", () => ({
  updateEmailEncrypted: (input: unknown) => updateEmailEncrypted(input),
  insertFolderExampleEncrypted: (input: unknown) => insertFolderExampleEncrypted(input),
}));

const regenerateFolderProfile = vi.fn(async (_folderId: string) => undefined);
vi.mock("./sync.server", () => ({
  regenerateFolderProfile: (folderId: string) => regenerateFolderProfile(folderId),
}));

import { performMove } from "./move-email.server";

const USER = "user-1";

function seedEmail(overrides: Record<string, unknown> = {}) {
  fake.seed("emails", [
    {
      id: "email-1",
      user_id: USER,
      folder_id: "folder-from",
      gmail_message_id: "gm-1",
      gmail_account_id: "acc-1",
      from_addr: "sender@x.com",
      raw_labels: ["INBOX", "L-FROM", "KEEP"],
      ...overrides,
    },
  ]);
}

function seedFolders() {
  fake.seed("folders", [
    { id: "folder-to", user_id: USER, name: "Receipts", gmail_label_id: "L-TO" },
    { id: "folder-from", user_id: USER, name: "Newsletters", gmail_label_id: "L-FROM" },
  ]);
}

beforeEach(() => {
  fake.reset();
  modifyMessage.mockClear();
  modifyMessage.mockResolvedValue({});
  updateEmailEncrypted.mockClear();
  updateEmailEncrypted.mockResolvedValue({ error: null });
  insertFolderExampleEncrypted.mockClear();
  regenerateFolderProfile.mockClear();
});

describe("guards (no mutation before ownership checks)", () => {
  it("returns Email not found for a missing email", async () => {
    const res = await performMove(USER, "nope", "folder-to");
    expect(res).toEqual({ ok: false, error: "Email not found" });
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
    expect(modifyMessage).not.toHaveBeenCalled();
    expect(fake.calls.updates).toHaveLength(0);
  });

  it("returns Email not found when the email belongs to another user", async () => {
    seedEmail({ user_id: "someone-else" });
    seedFolders();
    const res = await performMove(USER, "email-1", "folder-to");
    expect(res).toEqual({ ok: false, error: "Email not found" });
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
    expect(modifyMessage).not.toHaveBeenCalled();
  });

  it("no-ops when the email is already in the target folder", async () => {
    seedEmail({ folder_id: "folder-to" });
    seedFolders();
    const res = await performMove(USER, "email-1", "folder-to");
    expect(res).toEqual({ ok: true });
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
    expect(modifyMessage).not.toHaveBeenCalled();
    expect(fake.calls.updates).toHaveLength(0);
  });

  it("rejects a target folder that is missing or owned by another user", async () => {
    seedEmail();
    fake.seed("folders", [
      { id: "folder-to", user_id: "someone-else", name: "Theirs", gmail_label_id: "L-TO" },
      { id: "folder-from", user_id: USER, name: "Newsletters", gmail_label_id: "L-FROM" },
    ]);
    const res = await performMove(USER, "email-1", "folder-to");
    expect(res).toEqual({ ok: false, error: "Target folder not found" });
    expect(updateEmailEncrypted).not.toHaveBeenCalled();
    expect(modifyMessage).not.toHaveBeenCalled();
    expect(fake.calls.updates).toHaveLength(0);
  });
});

describe("label math and Gmail write-back", () => {
  it("strips INBOX + from-label, adds the target label, and archives locally", async () => {
    seedEmail();
    seedFolders();
    const res = await performMove(USER, "email-1", "folder-to");
    expect(res).toEqual({ ok: true });

    const emailUpdates = fake.calls.updates.filter((u) => u.table === "emails");
    expect(emailUpdates).toHaveLength(1);
    expect(emailUpdates[0].payload).toEqual({
      is_archived: true,
      raw_labels: ["KEEP", "L-TO"],
    });
    expect(emailUpdates[0].filters).toEqual([{ op: "eq", col: "id", value: "email-1" }]);

    expect(modifyMessage).toHaveBeenCalledTimes(1);
    expect(modifyMessage).toHaveBeenCalledWith("acc-1", "gm-1", ["L-TO"], ["INBOX", "L-FROM"]);
  });

  it("moving from the Inbox (no source folder) only removes INBOX and deletes no examples", async () => {
    seedEmail({ folder_id: null, raw_labels: ["INBOX", "KEEP"] });
    seedFolders();
    const res = await performMove(USER, "email-1", "folder-to");
    expect(res).toEqual({ ok: true });

    expect(modifyMessage).toHaveBeenCalledWith("acc-1", "gm-1", ["L-TO"], ["INBOX"]);
    expect(fake.calls.deletes).toHaveLength(0);
    expect(updateEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({ classification_reason: 'Moved to "Receipts" manually' }),
    );
  });

  it("swallows a Gmail modify failure — the local move still succeeds", async () => {
    seedEmail();
    seedFolders();
    modifyMessage.mockRejectedValueOnce(new Error("gmail 500"));
    const res = await performMove(USER, "email-1", "folder-to");
    expect(res).toEqual({ ok: true });
    // Training example still recorded after the swallowed Gmail error.
    expect(insertFolderExampleEncrypted).toHaveBeenCalledTimes(1);
  });
});

describe("encrypted-write ordering", () => {
  it("aborts before any local update or Gmail call when the encrypted write fails", async () => {
    seedEmail();
    seedFolders();
    updateEmailEncrypted.mockResolvedValueOnce({ error: "enc down" });
    const res = await performMove(USER, "email-1", "folder-to");
    expect(res).toEqual({ ok: false, error: "enc down" });
    expect(fake.calls.updates).toHaveLength(0);
    expect(modifyMessage).not.toHaveBeenCalled();
    expect(insertFolderExampleEncrypted).not.toHaveBeenCalled();
  });

  it("fails the move when the local flags update errors", async () => {
    seedEmail();
    seedFolders();
    fake.onUpdate("emails", () => ({ message: "db down" }));
    const res = await performMove(USER, "email-1", "folder-to");
    expect(res).toEqual({ ok: false, error: "db down" });
    expect(modifyMessage).not.toHaveBeenCalled();
  });

  it("writes classification via the encrypted writer with manual_move semantics", async () => {
    seedEmail();
    seedFolders();
    await performMove(USER, "email-1", "folder-to");
    expect(updateEmailEncrypted).toHaveBeenCalledWith({
      email_id: "email-1",
      folder_id: "folder-to",
      classified_by: "manual_move",
      ai_confidence: 1,
      classification_reason: 'Re-categorized from "Newsletters" to "Receipts"',
    });
  });
});

describe("training examples and retrain", () => {
  it("deletes the old folder example and inserts a correction for the target", async () => {
    seedEmail();
    seedFolders();
    await performMove(USER, "email-1", "folder-to");

    const exampleDeletes = fake.calls.deletes.filter((d) => d.table === "folder_examples");
    expect(exampleDeletes).toHaveLength(1);
    expect(exampleDeletes[0].filters).toEqual([
      { op: "eq", col: "folder_id", value: "folder-from" },
      { op: "eq", col: "gmail_message_id", value: "gm-1" },
    ]);

    expect(insertFolderExampleEncrypted).toHaveBeenCalledWith({
      folder_id: "folder-to",
      user_id: USER,
      gmail_account_id: "acc-1",
      gmail_message_id: "gm-1",
      from_addr: "sender@x.com",
      subject: null,
      snippet: null,
      source: "correction",
    });
    expect(regenerateFolderProfile).toHaveBeenCalledWith("folder-to");
  });

  it("uses reasonOverride verbatim when provided", async () => {
    seedEmail();
    seedFolders();
    await performMove(USER, "email-1", "folder-to", "AI rescue re-sort");
    expect(updateEmailEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({ classification_reason: "AI rescue re-sort" }),
    );
  });
});
