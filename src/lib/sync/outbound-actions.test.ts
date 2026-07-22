// Outbound email actions (rules upgrade, task 8). Contracts protected:
//
//   * templating is whitelist-only — unknown tokens stay literal, missing
//     data falls back, output is hard-capped at 4000 chars,
//   * dispatch always enqueues reply/draft/send_email (never inline on
//     the classify hot path) and rejects send_email without a recipient,
//   * the runner renders the DECRYPTED template and sends via Gmail —
//     reply threads onto the original, draft never sends, send_email
//     goes to the configured recipient,
//   * a template-less reply falls back to the (timeboxed) AI drafter,
//   * nothing rendered or AI-generated is persisted anywhere.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

const sendMessage = vi.fn(async (..._args: unknown[]) => ({}));
const createDraft = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../gmail.server", () => ({
  modifyMessage: async () => ({}),
  sendMessage: (...args: unknown[]) => sendMessage(...args),
  createDraft: (...args: unknown[]) => createDraft(...args),
}));

const getEmailsDecrypted = vi.fn();
vi.mock("./encrypted-reader", () => ({
  getEmailsDecrypted: (ids: string[]) => getEmailsDecrypted(ids),
}));

const suggestReply = vi.fn(async (_email: unknown) => "AI drafted reply");
vi.mock("../ai.server", () => ({
  suggestReply: (email: unknown) => suggestReply(email),
}));

import { renderTemplate, MAX_TEMPLATE_LEN } from "./action-templates";
import { dispatchFolderActions, type FolderActionRow } from "./action-dispatch";
import { runScheduledActions } from "./scheduled-actions";

const savedKey = process.env.EMAIL_ENC_KEY;

const EMAIL = {
  from_name: "Maya Okafor",
  from_addr: "maya@lattice-talent.com",
  subject: "Final round scheduling",
  body_text: "Hi Taylor,\n\nCould you pick a Thursday slot?",
  received_at: "2026-07-21T09:42:00Z",
};

beforeEach(() => {
  fake.reset();
  sendMessage.mockClear();
  createDraft.mockClear();
  suggestReply.mockClear();
  getEmailsDecrypted.mockReset();
  process.env.EMAIL_ENC_KEY = "test-enc-key";
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.EMAIL_ENC_KEY;
  else process.env.EMAIL_ENC_KEY = savedKey;
});

describe("renderTemplate", () => {
  it("substitutes every whitelisted token", () => {
    const out = renderTemplate(
      'Hi {{first_name}} ({{from_name}}), re: {{subject}} on {{received_at:short}} — "{{first_line}}"',
      EMAIL,
    );
    expect(out).toBe(
      'Hi Maya (Maya Okafor), re: Final round scheduling on Jul 21, 2026 — "Hi Taylor,"',
    );
  });

  it("falls back when data is missing and leaves unknown tokens literal", () => {
    const out = renderTemplate("Hey {{first_name}}, {{secret_env}} {{subject}}", {
      from_name: null,
      from_addr: null,
      subject: null,
      body_text: null,
      received_at: null,
    });
    expect(out).toBe("Hey there, {{secret_env}} (no subject)");
  });

  it("hard-caps output at MAX_TEMPLATE_LEN", () => {
    const out = renderTemplate("x".repeat(10_000), EMAIL);
    expect(out.length).toBe(MAX_TEMPLATE_LEN);
  });
});

describe("dispatch enqueues outbound actions", () => {
  const base = { parsed: { raw_labels: ["INBOX"] }, inInbox: true, persistFlags: true };

  it("reply with delay_minutes enqueues a scheduled_actions row", async () => {
    const action: FolderActionRow = {
      id: "act-r",
      action_type: "reply",
      label_id: null,
      move_to_folder_id: null,
      delay_minutes: 5,
    };
    const { outcomes } = await dispatchFolderActions({
      ...base,
      actions: [action],
      emailRowId: "e1",
      userId: "user-1",
    });
    expect(outcomes[0]).toMatchObject({ action_type: "reply", status: "pending" });
    const queued = fake.calls.inserts.filter((i) => i.table === "scheduled_actions");
    expect(queued).toHaveLength(1);
    const runAt = new Date((queued[0].payload as { run_at: string }).run_at).getTime();
    expect(runAt - Date.now()).toBeGreaterThan(4 * 60_000);
  });

  it("send_email without to_addr is rejected up front", async () => {
    const action: FolderActionRow = {
      id: "act-s",
      action_type: "send_email",
      label_id: null,
      move_to_folder_id: null,
      delay_minutes: 0,
      to_addr: null,
    };
    const { outcomes } = await dispatchFolderActions({
      ...base,
      actions: [action],
      emailRowId: "e1",
      userId: "user-1",
    });
    expect(outcomes[0].status).toBe("error");
    expect(outcomes[0].error).toContain("to_addr");
    expect(fake.calls.inserts.filter((i) => i.table === "scheduled_actions")).toHaveLength(0);
  });
});

describe("runner executes outbound actions", () => {
  function seedJob(actionType: string, cfg: Record<string, unknown>) {
    fake.onRpc("claim_scheduled_actions", () => ({
      data: [
        { id: "job-1", user_id: "user-1", folder_action_id: "act-1", email_id: "e1", attempt: 1 },
      ],
    }));
    fake.seed("folder_actions", [
      {
        id: "act-1",
        folder_id: "folder-A",
        action_type: actionType,
        label_id: null,
        move_to_folder_id: null,
        enabled: true,
      },
    ]);
    fake.onRpc("get_folder_action_outbound", () => ({
      data: [{ subject_template: null, body_template: null, to_addr: null, ...cfg }],
    }));
    getEmailsDecrypted.mockResolvedValue({
      rows: [
        {
          id: "e1",
          user_id: "user-1",
          gmail_account_id: "acc-1",
          gmail_message_id: "gm-1",
          thread_id: "t1",
          raw_labels: ["INBOX"],
          is_archived: false,
          ai_summary: null,
          ...EMAIL,
        },
      ],
      error: null,
    });
  }

  it("reply renders the template and sends threaded onto the original", async () => {
    seedJob("reply", { body_template: "Thanks {{first_name}}! Got it." });
    const r = await runScheduledActions(5);
    expect(r).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect(sendMessage).toHaveBeenCalledWith(
      "acc-1",
      "maya@lattice-talent.com",
      "Re: Final round scheduling",
      "Thanks Maya! Got it.",
      "t1",
      "gm-1",
    );
    expect(suggestReply).not.toHaveBeenCalled();
  });

  it("template-less reply falls back to the AI drafter", async () => {
    seedJob("reply", { body_template: null });
    const r = await runScheduledActions(5);
    expect(r.done).toBe(1);
    expect(suggestReply).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "acc-1",
      "maya@lattice-talent.com",
      "Re: Final round scheduling",
      "AI drafted reply",
      "t1",
      "gm-1",
    );
  });

  it("draft creates a Gmail draft and never sends", async () => {
    seedJob("draft", { body_template: "Draft for {{from_name}}" });
    const r = await runScheduledActions(5);
    expect(r.done).toBe(1);
    expect(createDraft).toHaveBeenCalledWith(
      "acc-1",
      "maya@lattice-talent.com",
      "Re: Final round scheduling",
      "Draft for Maya Okafor",
      "t1",
      "gm-1",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("send_email goes to the configured recipient with the rendered subject", async () => {
    seedJob("send_email", {
      body_template: "FYI: {{subject}}",
      subject_template: "Routed: {{subject}}",
      to_addr: "ops@nucar.com",
    });
    const r = await runScheduledActions(5);
    expect(r.done).toBe(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "acc-1",
      "ops@nucar.com",
      "Routed: Final round scheduling",
      "FYI: Final round scheduling",
    );
  });

  it("send_email without a stored recipient fails terminally", async () => {
    seedJob("send_email", { body_template: "hello", to_addr: null });
    const r = await runScheduledActions(5);
    expect(r.failed).toBe(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("draft with no template fails terminally instead of AI-drafting", async () => {
    seedJob("draft", { body_template: null });
    const r = await runScheduledActions(5);
    expect(r.failed).toBe(1);
    expect(suggestReply).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  });
});
