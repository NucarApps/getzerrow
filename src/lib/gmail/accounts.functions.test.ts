// src/lib/gmail/accounts.functions.ts — connect, disconnect, label plumbing.
// Everything here runs on the service-role client, so the only tenant
// isolation is the app-level guard (`getOwnedAccount`, or an inline
// `folder.user_id !== userId`). Each fn taking a client-supplied id gets a
// cross-user denial; the rest pin the write shape and the failure policy.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";

const fake = makeSupabaseFake({ applyWrites: true });

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@tanstack/react-start/server", () => ({ getRequestHost: () => "app.test" }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const gmail = vi.hoisted(() => ({
  listLabels:
    vi.fn<
      (...a: unknown[]) => Promise<{ labels?: Array<{ id: string; name: string; type?: string }> }>
    >(),
  createLabel: vi.fn<(...a: unknown[]) => Promise<{ id: string }>>(),
  modifyMessage: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  ensureWatch:
    vi.fn<(...a: unknown[]) => Promise<{ historyId: string; expiration: string } | null>>(),
  stopWatch: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  listMessages: vi.fn<(...a: unknown[]) => Promise<{ messages?: Array<{ id: string }> }>>(),
  getMessageMetadata: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  parseMessage: vi.fn<(raw: unknown) => Record<string, unknown>>(),
}));
vi.mock("../gmail.server", () => ({
  listLabels: (...a: unknown[]) => gmail.listLabels(...a),
  createLabel: (...a: unknown[]) => gmail.createLabel(...a),
  modifyMessage: (...a: unknown[]) => gmail.modifyMessage(...a),
  ensureWatch: (...a: unknown[]) => gmail.ensureWatch(...a),
  stopWatch: (...a: unknown[]) => gmail.stopWatch(...a),
  listMessages: (...a: unknown[]) => gmail.listMessages(...a),
  getMessageMetadata: (...a: unknown[]) => gmail.getMessageMetadata(...a),
  parseMessage: (raw: unknown) => gmail.parseMessage(raw),
}));

const sync = vi.hoisted(() => ({
  backfillRecent: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  startBackfillJob: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  learnFromLinkedLabel: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
}));
vi.mock("../sync.server", () => ({
  backfillRecent: (...a: unknown[]) => sync.backfillRecent(...a),
  startBackfillJob: (...a: unknown[]) => sync.startBackfillJob(...a),
  learnFromLinkedLabel: (...a: unknown[]) => sync.learnFromLinkedLabel(...a),
}));

const ai = vi.hoisted(() => ({
  generateAiRuleFromPurpose: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  generateAiRuleFromLabelSamples: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
}));
vi.mock("../ai.server", () => ({
  generateAiRuleFromPurpose: (...a: unknown[]) => ai.generateAiRuleFromPurpose(...a),
  generateAiRuleFromLabelSamples: (...a: unknown[]) => ai.generateAiRuleFromLabelSamples(...a),
}));

const oauth = vi.hoisted(() => ({
  signState: vi.fn<(userId: string) => Promise<string>>(),
  buildAuthorizeUrl: vi.fn<(...a: unknown[]) => string>(),
  getRedirectUri: vi.fn<(origin: string) => string>(),
  revokeGoogleOAuthForAccount: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
}));
vi.mock("../google-oauth.server", () => ({
  signState: (userId: string) => oauth.signState(userId),
  buildAuthorizeUrl: (...a: unknown[]) => oauth.buildAuthorizeUrl(...a),
  getRedirectUri: (origin: string) => oauth.getRedirectUri(origin),
  revokeGoogleOAuthForAccount: (...a: unknown[]) => oauth.revokeGoogleOAuthForAccount(...a),
}));

const logAudit = vi.hoisted(() => vi.fn<(event: string, fields: unknown) => void>());
const logError = vi.hoisted(() => vi.fn<(...a: unknown[]) => void>());
vi.mock("../log.server", () => ({
  logAudit: (event: string, fields: unknown) => logAudit(event, fields),
  logError: (...a: unknown[]) => logError(...a),
  logInfo: () => {},
}));

vi.mock("@/lib/email-enc-key", () => ({ emailEncKey: () => "test-enc-key" }));

import {
  listMyGmailAccounts,
  startConnectGmail,
  connectGmailFromSession,
  disconnectGmailAccount,
  listGmailLabels,
  createGmailLabel,
  generateFolderAiRule,
  generateFolderAiRuleFromLabel,
  learnFolderFromLabel,
  applyFolderLabelToLocal,
} from "./accounts.functions";

const USER = TEST_USER;
const ATTACKER = "attacker-user-9";
const VICTIM = "victim-user-7";
const ACCOUNT = "aaaaaaaa-1111-4111-8111-111111111111";
const FOLDER = "bbbbbbbb-2222-4222-8222-222222222222";
const NOW = "2026-05-01T12:00:00.000Z";

beforeEach(() => {
  fake.reset();
  for (const fn of [...Object.values(gmail), ...Object.values(sync), ...Object.values(ai)]) {
    fn.mockReset();
  }
  gmail.listLabels.mockResolvedValue({ labels: [] });
  gmail.ensureWatch.mockResolvedValue(null);
  gmail.stopWatch.mockResolvedValue(undefined);
  gmail.modifyMessage.mockResolvedValue({});
  sync.backfillRecent.mockResolvedValue(undefined);
  sync.startBackfillJob.mockResolvedValue(undefined);
  oauth.signState.mockResolvedValue("signed-state");
  oauth.getRedirectUri.mockReturnValue("https://app.test/oauth/callback");
  oauth.buildAuthorizeUrl.mockReturnValue("https://accounts.google.test/authorize");
  oauth.revokeGoogleOAuthForAccount.mockResolvedValue(undefined);
  logAudit.mockClear();
  logError.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* listMyGmailAccounts                                                         */
/* -------------------------------------------------------------------------- */

describe("listMyGmailAccounts", () => {
  it("returns only the caller's mailboxes and never leaks the encrypted token", async () => {
    fake.seed("gmail_accounts", [
      {
        id: ACCOUNT,
        user_id: USER,
        email_address: "me@acme.test",
        history_id: "42",
        watch_expiration: NOW,
        last_poll_at: null,
        created_at: "2026-01-01T00:00:00Z",
        refresh_token_enc: "cipher",
        needs_reconnect: false,
      },
      { id: "other", user_id: VICTIM, email_address: "victim@acme.test" },
    ]);

    const res = await impersonate(listMyGmailAccounts, USER)();

    expect(res).toStrictEqual({
      accounts: [
        {
          id: ACCOUNT,
          email_address: "me@acme.test",
          history_id: "42",
          watch_expiration: NOW,
          last_poll_at: null,
          created_at: "2026-01-01T00:00:00Z",
          needs_reauth: false,
        },
      ],
    });
  });

  it("flags a mailbox needing reauth when the token is gone or reconnect is set", async () => {
    fake.seed("gmail_accounts", [
      {
        id: ACCOUNT,
        user_id: USER,
        email_address: "a@acme.test",
        created_at: "2026-01-01T00:00:00Z",
        refresh_token_enc: null,
        needs_reconnect: false,
      },
      {
        id: "acct-2",
        user_id: USER,
        email_address: "b@acme.test",
        created_at: "2026-01-02T00:00:00Z",
        refresh_token_enc: "cipher",
        needs_reconnect: true,
      },
    ]);

    const res = await impersonate(listMyGmailAccounts, USER)();
    expect(
      (res as { accounts: Array<{ needs_reauth: boolean }> }).accounts.map((a) => a.needs_reauth),
    ).toStrictEqual([true, true]);
  });

  it("propagates a read failure with context", async () => {
    fake.onSelect("gmail_accounts", () => ({ message: "policy error" }));
    await expect(impersonate(listMyGmailAccounts, USER)()).rejects.toThrow(
      "Failed to load Gmail accounts: policy error",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* startConnectGmail / connectGmailFromSession                                 */
/* -------------------------------------------------------------------------- */

describe("startConnectGmail", () => {
  it("signs the state with the caller's own id and derives the redirect from the host", async () => {
    const res = await startConnectGmail({ data: { login_hint: "me@acme.test" } });

    expect(res).toStrictEqual({ url: "https://accounts.google.test/authorize" });
    expect(oauth.getRedirectUri).toHaveBeenCalledWith("https://app.test");
    expect(oauth.signState).toHaveBeenCalledWith(USER);
    expect(oauth.buildAuthorizeUrl).toHaveBeenCalledWith(
      "https://app.test/oauth/callback",
      "signed-state",
      "me@acme.test",
    );
  });
});

describe("connectGmailFromSession", () => {
  const session = {
    access_token: "at",
    refresh_token: "rt",
    expires_in: 3600,
    email_address: "Me@Acme.test",
  };

  it("stores the tokens through the encrypting RPC, keyed to the caller", async () => {
    fake.onRpc("upsert_gmail_oauth_account", () => ({ data: ACCOUNT }));

    const res = await connectGmailFromSession({ data: session });

    expect(res).toStrictEqual({ account_id: ACCOUNT });
    expect(fake.calls.rpcs).toStrictEqual([
      {
        fn: "upsert_gmail_oauth_account",
        args: {
          p_user_id: USER,
          p_email_address: "me@acme.test",
          p_access_token: "at",
          p_refresh_token: "rt",
          p_token_expires_at: "2026-05-01T13:00:00.000Z",
          p_key: "test-enc-key",
        },
      },
    ]);
    expect(logAudit).toHaveBeenCalledWith("gmail.connected", {
      user_id: USER,
      account_id: ACCOUNT,
    });
  });

  it("writes the watch fields when Gmail returns a subscription", async () => {
    fake.onRpc("upsert_gmail_oauth_account", () => ({ data: ACCOUNT }));
    gmail.ensureWatch.mockResolvedValue({ historyId: "99", expiration: "1780000000000" });

    await connectGmailFromSession({ data: session });

    const update = fake.calls.updates.find((u) => u.table === "gmail_accounts");
    expect(update?.payload).toStrictEqual({
      history_id: "99",
      watch_expiration: new Date(1780000000000).toISOString(),
    });
  });

  it("writes no watch fields but still runs both backfills when ensureWatch returns null", async () => {
    fake.onRpc("upsert_gmail_oauth_account", () => ({ data: ACCOUNT }));
    gmail.ensureWatch.mockResolvedValue(null);

    await connectGmailFromSession({ data: session });

    expect(writeCount(fake)).toBe(0);
    expect(sync.backfillRecent).toHaveBeenCalledWith(ACCOUNT, USER, 30);
    expect(sync.startBackfillJob).toHaveBeenCalledWith(ACCOUNT, USER, { months: 6 });
  });

  it("keeps going when the watch and the recent backfill both throw", async () => {
    fake.onRpc("upsert_gmail_oauth_account", () => ({ data: ACCOUNT }));
    gmail.ensureWatch.mockRejectedValue(new Error("watch boom"));
    sync.backfillRecent.mockRejectedValue(new Error("backfill boom"));

    await expect(connectGmailFromSession({ data: session })).resolves.toStrictEqual({
      account_id: ACCOUNT,
    });
    expect(sync.startBackfillJob).toHaveBeenCalledTimes(1);
  });

  it("throws without auditing when the RPC returns no account id", async () => {
    fake.onRpc("upsert_gmail_oauth_account", () => ({ data: null }));

    await expect(connectGmailFromSession({ data: session })).rejects.toThrow(
      "Failed to save account",
    );
    expect(logAudit).not.toHaveBeenCalled();
    expect(gmail.ensureWatch).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* disconnectGmailAccount                                                      */
/* -------------------------------------------------------------------------- */

describe("disconnectGmailAccount", () => {
  it("denies another user's account before stopping the watch", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: VICTIM, email_address: "v@acme.test" }]);

    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(disconnectGmailAccount, ATTACKER)({ data: { account_id: ACCOUNT } }),
      rejects: "Not authorized for this account",
    });
    expect(gmail.stopWatch).not.toHaveBeenCalled();
    expect(oauth.revokeGoogleOAuthForAccount).not.toHaveBeenCalled();
  });

  it("stops the watch, revokes the grant, purges the content and drops the row", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: USER, email_address: "me@acme.test" }]);
    fake.onRpc("delete_gmail_account_content", () => ({ data: 17 }));

    const res = await disconnectGmailAccount({ data: { account_id: ACCOUNT } });

    expect(res).toStrictEqual({ ok: true });
    expect(gmail.stopWatch).toHaveBeenCalledWith(ACCOUNT);
    expect(oauth.revokeGoogleOAuthForAccount).toHaveBeenCalledWith(ACCOUNT);
    expect(fake.calls.rpcs).toStrictEqual([
      {
        fn: "delete_gmail_account_content",
        args: { p_account_id: ACCOUNT, p_user_id: USER },
      },
    ]);
    expect(fake.rows("gmail_accounts")).toStrictEqual([]);
    expect(logAudit).toHaveBeenCalledWith("gmail.disconnected", {
      user_id: USER,
      account_id: ACCOUNT,
      emails_purged: 17,
      purge_ok: true,
    });
  });

  it("still deletes the account row and records purge_ok:false when the purge RPC fails", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: USER, email_address: "me@acme.test" }]);
    fake.onRpc("delete_gmail_account_content", () => ({ error: { message: "purge blocked" } }));

    await expect(disconnectGmailAccount({ data: { account_id: ACCOUNT } })).resolves.toStrictEqual({
      ok: true,
    });

    expect(fake.rows("gmail_accounts")).toStrictEqual([]);
    expect(logAudit).toHaveBeenCalledWith("gmail.disconnected", {
      user_id: USER,
      account_id: ACCOUNT,
      emails_purged: 0,
      purge_ok: false,
    });
  });

  it("disconnects even when stopWatch and the OAuth revoke both throw", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: USER, email_address: "me@acme.test" }]);
    gmail.stopWatch.mockRejectedValue(new Error("stop boom"));
    oauth.revokeGoogleOAuthForAccount.mockRejectedValue(new Error("revoke boom"));

    await expect(disconnectGmailAccount({ data: { account_id: ACCOUNT } })).resolves.toStrictEqual({
      ok: true,
    });
    expect(fake.rows("gmail_accounts")).toStrictEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* listGmailLabels / createGmailLabel                                          */
/* -------------------------------------------------------------------------- */

describe("listGmailLabels", () => {
  it("denies another user's account", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: VICTIM, email_address: "v@acme.test" }]);

    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(listGmailLabels, ATTACKER)({ data: { account_id: ACCOUNT } }),
      rejects: "Not authorized for this account",
    });
    expect(gmail.listLabels).not.toHaveBeenCalled();
  });

  it("drops Gmail's system labels", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: USER, email_address: "me@acme.test" }]);
    gmail.listLabels.mockResolvedValue({
      labels: [
        { id: "l1", name: "Atzro/Work", type: "user" },
        { id: "INBOX", name: "INBOX", type: "system" },
      ],
    });

    const res = await listGmailLabels({ data: { account_id: ACCOUNT } });
    expect(res).toStrictEqual({ labels: [{ id: "l1", name: "Atzro/Work", type: "user" }] });
  });
});

describe("createGmailLabel", () => {
  beforeEach(() => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: USER, email_address: "me@acme.test" }]);
  });

  it("denies another user's account", async () => {
    fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: VICTIM, email_address: "v@acme.test" }]);

    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(createGmailLabel, ATTACKER)({ data: { account_id: ACCOUNT, name: "Work" } }),
      rejects: "Not authorized for this account",
    });
    expect(gmail.createLabel).not.toHaveBeenCalled();
  });

  it("namespaces a new top-level label under Atzro/", async () => {
    gmail.createLabel.mockResolvedValue({ id: "new-1" });

    const res = await createGmailLabel({ data: { account_id: ACCOUNT, name: "Work" } });

    expect(res).toStrictEqual({ id: "new-1" });
    expect(gmail.createLabel).toHaveBeenCalledWith(ACCOUNT, "Atzro/Work");
  });

  it("returns the existing label's id instead of creating a duplicate", async () => {
    gmail.listLabels.mockResolvedValue({ labels: [{ id: "l1", name: "Atzro/Work" }] });

    const res = await createGmailLabel({ data: { account_id: ACCOUNT, name: "Work" } });

    expect(res).toStrictEqual({ id: "l1" });
    expect(gmail.createLabel).not.toHaveBeenCalled();
  });

  it("rejects a parent label outside the Atzro namespace", async () => {
    gmail.listLabels.mockResolvedValue({ labels: [{ id: "p1", name: "Personal" }] });

    await expect(
      createGmailLabel({ data: { account_id: ACCOUNT, name: "Work", parent_label_id: "p1" } }),
    ).rejects.toThrow("Parent label must be within Atzro namespace");
    expect(gmail.createLabel).not.toHaveBeenCalled();
  });

  it("rejects a parent label id that does not exist in the mailbox", async () => {
    gmail.listLabels.mockResolvedValue({ labels: [] });

    await expect(
      createGmailLabel({ data: { account_id: ACCOUNT, name: "Work", parent_label_id: "ghost" } }),
    ).rejects.toThrow("Parent label not found");
  });

  it("nests under an Atzro parent, including the bare root", async () => {
    gmail.listLabels.mockResolvedValue({
      labels: [
        { id: "root", name: "Atzro" },
        { id: "sub", name: "Atzro/Clients" },
      ],
    });
    gmail.createLabel.mockResolvedValue({ id: "new-2" });

    await createGmailLabel({
      data: { account_id: ACCOUNT, name: "Work", parent_label_id: "root" },
    });
    expect(gmail.createLabel).toHaveBeenCalledWith(ACCOUNT, "Atzro/Work");

    await createGmailLabel({ data: { account_id: ACCOUNT, name: "Acme", parent_label_id: "sub" } });
    expect(gmail.createLabel).toHaveBeenLastCalledWith(ACCOUNT, "Atzro/Clients/Acme");
  });
});

/* -------------------------------------------------------------------------- */
/* generateFolderAiRule / generateFolderAiRuleFromLabel                        */
/* -------------------------------------------------------------------------- */

describe("generateFolderAiRule", () => {
  it("forwards the purpose and folder name to the model helper", async () => {
    ai.generateAiRuleFromPurpose.mockResolvedValue({ conditions: [] });

    const res = await generateFolderAiRule({
      data: { purpose: "invoices only", folder_name: "Billing" },
    });

    expect(res).toStrictEqual({ rule: { conditions: [] } });
    expect(ai.generateAiRuleFromPurpose).toHaveBeenCalledWith({
      purpose: "invoices only",
      folderName: "Billing",
    });
  });
});

describe("generateFolderAiRuleFromLabel", () => {
  it("denies another user's folder", async () => {
    fake.seed("folders", [
      {
        id: FOLDER,
        user_id: VICTIM,
        name: "Victim",
        gmail_label_id: "l1",
        gmail_account_id: ACCOUNT,
      },
    ]);

    await expectDeniedCrossUser({
      fake,
      call: () =>
        impersonate(generateFolderAiRuleFromLabel, ATTACKER)({ data: { folder_id: FOLDER } }),
      rejects: "Folder not found",
    });
    expect(gmail.listMessages).not.toHaveBeenCalled();
  });

  it("asks the caller to link a label before it will sample anything", async () => {
    fake.seed("folders", [
      { id: FOLDER, user_id: USER, name: "Work", gmail_label_id: null, gmail_account_id: ACCOUNT },
    ]);

    await expect(generateFolderAiRuleFromLabel({ data: { folder_id: FOLDER } })).rejects.toThrow(
      "Link a Gmail label first, then save.",
    );
    expect(gmail.listMessages).not.toHaveBeenCalled();
  });

  it("refuses to guess from an empty label", async () => {
    fake.seed("folders", [
      { id: FOLDER, user_id: USER, name: "Work", gmail_label_id: "l1", gmail_account_id: ACCOUNT },
    ]);
    gmail.listMessages.mockResolvedValue({ messages: [] });

    await expect(generateFolderAiRuleFromLabel({ data: { folder_id: FOLDER } })).rejects.toThrow(
      "No emails found under this label to learn from.",
    );
    expect(ai.generateAiRuleFromLabelSamples).not.toHaveBeenCalled();
  });

  it("samples the label and skips messages it cannot read", async () => {
    fake.seed("folders", [
      { id: FOLDER, user_id: USER, name: "Work", gmail_label_id: "l1", gmail_account_id: ACCOUNT },
    ]);
    gmail.listMessages.mockResolvedValue({ messages: [{ id: "m1" }, { id: "m2" }] });
    gmail.getMessageMetadata.mockImplementation(async (_acct: unknown, id: unknown) => {
      if (id === "m2") throw new Error("410 gone");
      return { id };
    });
    gmail.parseMessage.mockReturnValue({
      from_name: "Jane",
      from_addr: "jane@acme.test",
      subject: "Invoice",
      snippet: "due",
    });
    ai.generateAiRuleFromLabelSamples.mockResolvedValue({ conditions: ["x"] });

    const res = await generateFolderAiRuleFromLabel({ data: { folder_id: FOLDER } });

    expect(res).toStrictEqual({ rule: { conditions: ["x"] } });
    expect(gmail.listMessages).toHaveBeenCalledWith(ACCOUNT, {
      maxResults: 40,
      labelIds: ["l1"],
    });
    expect(ai.generateAiRuleFromLabelSamples).toHaveBeenCalledWith({
      folderName: "Work",
      samples: [{ from: "Jane jane@acme.test", subject: "Invoice", snippet: "due" }],
    });
  });
});

/* -------------------------------------------------------------------------- */
/* learnFolderFromLabel                                                        */
/* -------------------------------------------------------------------------- */

describe("learnFolderFromLabel", () => {
  // RLS-RELIANCE: this fn does no ownership read of its own — it forwards the
  // client-supplied folder id together with the caller's user id to
  // `learnFromLinkedLabel`, which owns the check. Pinned so a refactor that
  // drops the user id from that call is visible.
  it("forwards the caller's own user id alongside the folder id", async () => {
    sync.learnFromLinkedLabel.mockResolvedValue({ learned: 3 });

    const res = await impersonate(learnFolderFromLabel, ATTACKER)({ data: { folder_id: FOLDER } });

    expect(res).toStrictEqual({ learned: 3 });
    expect(sync.learnFromLinkedLabel).toHaveBeenCalledWith(FOLDER, ATTACKER);
    expect(writeCount(fake)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* applyFolderLabelToLocal                                                     */
/* -------------------------------------------------------------------------- */

describe("applyFolderLabelToLocal", () => {
  it("denies another user's folder", async () => {
    fake.seed("folders", [
      {
        id: FOLDER,
        user_id: VICTIM,
        name: "Victim",
        gmail_label_id: "l1",
        gmail_account_id: ACCOUNT,
      },
    ]);

    await expectDeniedCrossUser({
      fake,
      call: () => impersonate(applyFolderLabelToLocal, ATTACKER)({ data: { folder_id: FOLDER } }),
      rejects: "Folder not found",
    });
    expect(gmail.modifyMessage).not.toHaveBeenCalled();
  });

  it("refuses when the folder has no linked label", async () => {
    fake.seed("folders", [
      { id: FOLDER, user_id: USER, name: "Work", gmail_label_id: null, gmail_account_id: ACCOUNT },
    ]);

    await expect(applyFolderLabelToLocal({ data: { folder_id: FOLDER } })).rejects.toThrow(
      "Folder is not linked to a Gmail label",
    );
  });

  it("skips already-labelled rows and archives the ones it moves", async () => {
    fake.seed("folders", [
      { id: FOLDER, user_id: USER, name: "Work", gmail_label_id: "l1", gmail_account_id: ACCOUNT },
    ]);
    fake.seed("emails", [
      {
        id: "e-todo",
        user_id: USER,
        folder_id: FOLDER,
        gmail_message_id: "m1",
        gmail_account_id: ACCOUNT,
        raw_labels: ["INBOX"],
      },
      {
        id: "e-done",
        user_id: USER,
        folder_id: FOLDER,
        gmail_message_id: "m2",
        gmail_account_id: ACCOUNT,
        raw_labels: ["l1"],
      },
      // Another tenant's row in the same folder id is filtered out by user_id.
      {
        id: "e-foreign",
        user_id: VICTIM,
        folder_id: FOLDER,
        gmail_message_id: "m3",
        gmail_account_id: ACCOUNT,
        raw_labels: ["INBOX"],
      },
    ]);

    const res = await applyFolderLabelToLocal({ data: { folder_id: FOLDER } });

    expect(res).toStrictEqual({ total: 1, synced: 1, failed: 0 });
    expect(gmail.modifyMessage).toHaveBeenCalledTimes(1);
    expect(gmail.modifyMessage).toHaveBeenCalledWith(ACCOUNT, "m1", ["l1"], ["INBOX"]);
    // INBOX is dropped from the merged label set and the row is archived.
    expect(fake.rows("emails").find((e) => e.id === "e-todo")).toMatchObject({
      raw_labels: ["l1"],
      is_archived: true,
    });
    expect(fake.rows("emails").find((e) => e.id === "e-foreign")).toMatchObject({
      raw_labels: ["INBOX"],
    });
  });

  it("counts a Gmail failure without writing that row", async () => {
    fake.seed("folders", [
      { id: FOLDER, user_id: USER, name: "Work", gmail_label_id: "l1", gmail_account_id: ACCOUNT },
    ]);
    fake.seed("emails", [
      {
        id: "e1",
        user_id: USER,
        folder_id: FOLDER,
        gmail_message_id: "m1",
        gmail_account_id: ACCOUNT,
        raw_labels: ["INBOX"],
      },
      {
        id: "e2",
        user_id: USER,
        folder_id: FOLDER,
        gmail_message_id: "m2",
        gmail_account_id: ACCOUNT,
        raw_labels: ["INBOX"],
      },
    ]);
    gmail.modifyMessage.mockImplementation(async (_acct: unknown, msgId: unknown) => {
      if (msgId === "m1") throw new Error("gmail 500");
      return {};
    });

    const res = await applyFolderLabelToLocal({ data: { folder_id: FOLDER } });

    expect(res).toStrictEqual({ total: 2, synced: 1, failed: 1 });
    expect(fake.calls.updates.filter((u) => u.table === "emails")).toHaveLength(1);
    expect(fake.rows("emails").find((e) => e.id === "e1")).toMatchObject({
      raw_labels: ["INBOX"],
    });
  });
});
