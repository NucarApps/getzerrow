// Cron run log (rules upgrade, task 13). Contracts:
//
//   * one pubsub_events row per call — event_type, details, error —
//     matching the shape every other cron's run rows use,
//   * details are bounded (a runaway error string can't bloat the row),
//   * the logger NEVER throws — a failed run-log write must not fail
//     the cron tick it was logging.

import { describe, it, expect, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();
let dbDown = false;

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (dbDown) throw new Error("db down");
      return fake.supabaseAdmin.from(table);
    },
    rpc: (fn: string, args?: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

const { logCronRunEvent } = await import("./cron-run-log.server");

describe("logCronRunEvent", () => {
  it("writes one pubsub_events row with event_type, details, and error", async () => {
    await logCronRunEvent(
      "scheduled_actions_run",
      "claimed=3 done=2 retried=0 failed=1",
      "1 action failed terminally",
    );

    const rows = fake.calls.inserts.filter((i) => i.table === "pubsub_events");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      event_type: "scheduled_actions_run",
      details: "claimed=3 done=2 retried=0 failed=1",
      error: "1 action failed terminally",
    });
  });

  it("defaults error to null and bounds oversized details", async () => {
    fake.calls.inserts.length = 0;
    await logCronRunEvent("send_digest_run", "x".repeat(5000));

    const rows = fake.calls.inserts.filter((i) => i.table === "pubsub_events");
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as { details: string; error: string | null };
    expect(payload.details).toHaveLength(2000);
    expect(payload.error).toBeNull();
  });

  it("swallows write failures instead of throwing", async () => {
    dbDown = true;
    try {
      await expect(
        logCronRunEvent("categorize_senders_run", "users=0 labeled=0 skipped=0"),
      ).resolves.toBeUndefined();
    } finally {
      dbDown = false;
    }
  });
});
