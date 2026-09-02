// Status endpoints for the contacts AI tools (ai-scan-status.functions.ts).
// Contracts protected:
//
//   * every read is scoped to the authenticated user id (these run on the
//     user-scoped client, but the explicit user_id predicate is what keeps
//     the untyped contact_enrich_jobs accessor honest),
//   * getContactAiScanStatus returns the newest job of the requested kind
//     and null when the user has never scanned,
//   * getContactAiToolsStatus reports pending counts and last activity per
//     tool, and flags a scan as active only for the matching job kind,
//   * a failing read surfaces rather than silently reporting "never
//     scanned".
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { makeSuggestionRow } from "./__fixtures__/rows";

const rls = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import { getContactAiScanStatus, getContactAiToolsStatus } from "./ai-scan-status.functions";

const VICTIM = "victim-user-2";

type CallArgs = { data?: unknown; context?: Record<string, unknown> };
function call(fn: unknown, args: CallArgs): Promise<never> {
  return (fn as (a: CallArgs) => Promise<never>)(args);
}
const asUser = { supabase: rls.supabaseAdmin };

/** contact_enrich_jobs is not in the generated types yet — the module goes
 * through an untyped accessor, so the seed does too. */
function seedJobs(rows: Array<Record<string, unknown>>) {
  rls.seedRaw("contact_enrich_jobs", rows);
}

beforeEach(() => {
  rls.reset();
});

describe("getContactAiScanStatus", () => {
  it("returns the newest job of the requested kind for the caller only", async () => {
    seedJobs([
      {
        user_id: TEST_USER,
        kind: "signature_scan",
        status: "done",
        error: null,
        created_at: "2026-02-01T00:00:00Z",
        finished_at: "2026-02-01T00:05:00Z",
      },
      {
        user_id: TEST_USER,
        kind: "signature_scan",
        status: "running",
        error: null,
        created_at: "2026-02-09T00:00:00Z",
        finished_at: null,
      },
      // Another kind, and another tenant's newer job: both excluded.
      {
        user_id: TEST_USER,
        kind: "dedup_scan",
        status: "failed",
        error: "boom",
        created_at: "2026-02-10T00:00:00Z",
        finished_at: null,
      },
      {
        user_id: VICTIM,
        kind: "signature_scan",
        status: "failed",
        error: "victim",
        created_at: "2026-02-20T00:00:00Z",
        finished_at: null,
      },
    ]);
    const res = (await call(getContactAiScanStatus, {
      data: { kind: "signature_scan" },
      context: asUser,
    })) as unknown as { job: { status: string; created_at: string } | null };
    // toMatchObject, not toStrictEqual: the fake hands back whole seeded
    // rows rather than the selected column list.
    expect(res.job).toMatchObject({
      kind: "signature_scan",
      status: "running",
      error: null,
      created_at: "2026-02-09T00:00:00Z",
      finished_at: null,
    });
    expect(rls.calls.selects[0]!.filters).toStrictEqual([
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
      { op: "eq", col: "kind", value: "signature_scan", extra: undefined },
    ]);
  });

  it("reports null when the user has never run that scan", async () => {
    const res = (await call(getContactAiScanStatus, {
      data: { kind: "dedup_scan" },
      context: asUser,
    })) as unknown as { job: unknown };
    expect(res.job).toBeNull();
  });

  it("zod rejects an unknown scan kind", async () => {
    await expect(
      call(getContactAiScanStatus, { data: { kind: "everything" }, context: asUser }),
    ).rejects.toThrow();
  });

  it("a failing read surfaces rather than reporting 'never scanned'", async () => {
    rls.onSelect("contact_enrich_jobs", () => ({ message: "statement timeout" }));
    await expect(
      call(getContactAiScanStatus, { data: { kind: "dedup_scan" }, context: asUser }),
    ).rejects.toThrow("statement timeout");
  });
});

describe("getContactAiToolsStatus", () => {
  it("counts pending suggestions per tool and flags only the running scan kind", async () => {
    rls.seed("contact_enrichment_suggestions", [
      makeSuggestionRow({ id: "s1", user_id: TEST_USER, created_at: "2026-02-01T00:00:00Z" }),
      makeSuggestionRow({
        id: "s2",
        user_id: TEST_USER,
        status: "applied",
        created_at: "2026-02-08T00:00:00Z",
      }),
      makeSuggestionRow({ id: "s3", user_id: VICTIM, created_at: "2026-02-20T00:00:00Z" }),
    ]);
    rls.seed("contact_group_suggestions", [
      {
        id: "g1",
        user_id: TEST_USER,
        run_id: "run-1",
        name: "auto-rule",
        kind: "merge_into_existing",
        status: "pending",
        contact_ids: ["c1"],
        created_at: "2026-02-02T00:00:00Z",
      },
    ]);
    seedJobs([
      { user_id: TEST_USER, kind: "signature_scan", status: "running" },
      { user_id: TEST_USER, kind: "dedup_scan", status: "done" },
    ]);

    const res = (await call(getContactAiToolsStatus, {
      data: {},
      context: asUser,
    })) as unknown as {
      groups: { pendingCount: number; lastActivityAt: string | null; scanActive: boolean };
      duplicates: { pendingCount: number; scanActive: boolean };
      enrichment: { pendingCount: number; lastActivityAt: string | null; scanActive: boolean };
    };
    expect(res.groups).toStrictEqual({
      pendingCount: 1,
      lastActivityAt: "2026-02-02T00:00:00Z",
      scanActive: false,
    });
    expect(res.duplicates).toStrictEqual({
      pendingCount: 0,
      lastActivityAt: null,
      scanActive: false,
    });
    expect(res.enrichment).toStrictEqual({
      pendingCount: 1,
      // Newest row of the caller's own, pending or not.
      lastActivityAt: "2026-02-08T00:00:00Z",
      scanActive: true,
    });
  });

  it("reports every tool as idle for an account with no rows", async () => {
    const res = (await call(getContactAiToolsStatus, { data: {}, context: asUser })) as unknown as {
      enrichment: { pendingCount: number; lastActivityAt: string | null; scanActive: boolean };
    };
    expect(res.enrichment).toStrictEqual({
      pendingCount: 0,
      lastActivityAt: null,
      scanActive: false,
    });
  });
});
