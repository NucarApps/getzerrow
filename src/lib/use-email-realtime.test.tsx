// Tests for the useEmailRealtime hook body (src/lib/use-email-realtime.ts).
//
// The pure decision helpers (rowBelongsInList, applyPendingOpsToList,
// isDamagedPayload) are covered by realtime-belongs.test.ts, and the
// connection lifecycle by ui/realtime-coalescer.test.ts. What is left — and
// what this file covers — is the wiring between them: which cached queries a
// realtime event touches, how many times the cache and the folder counts are
// written for a burst, and that nothing survives an unmount.
//
// The supabase client is replaced with a channel recorder so the test can
// deliver postgres_changes payloads by hand, and requestAnimationFrame is
// stubbed so the rAF batch flushes exactly when the test says so.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const box = vi.hoisted(() => ({
  rt: null as import("@/lib/__fixtures__/realtime-client").RealtimeClientFake | null,
}));

vi.mock("@/integrations/supabase/client", async () => {
  const { makeRealtimeClientFake } = await import("@/lib/__fixtures__/realtime-client");
  box.rt = makeRealtimeClientFake();
  return { supabase: box.rt.supabase };
});

/** The fake client the hook is talking to. */
function rt() {
  if (!box.rt) throw new Error("realtime fake was never installed");
  return box.rt;
}

import { useEmailRealtime, type EmailRow } from "./use-email-realtime";

const ACCOUNT = "acct-1";
const INBOX_KEY = ["emails", ACCOUNT, "all", "page:0"] as const;

function emailRow(overrides: Partial<EmailRow> & { id: string }): EmailRow {
  return {
    user_id: "user-1",
    gmail_message_id: `gm-${overrides.id}`,
    received_at: "2026-09-02T10:00:00.000Z",
    is_archived: false,
    folder_id: null,
    gmail_account_id: ACCOUNT,
    raw_labels: ["INBOX"],
    classified_by: "rules",
    ...overrides,
  };
}

/** Hand-driven animation frames. */
const frames: Array<() => void> = [];
function runFrames() {
  const queued = frames.splice(0, frames.length);
  for (const run of queued) run();
}

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const setQueryData = vi.spyOn(qc, "setQueryData");
  const invalidateQueries = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useEmailRealtime(), { wrapper });
  return { qc, setQueryData, invalidateQueries, view };
}

function channel() {
  return rt().latest();
}

function deliver(event: "INSERT" | "UPDATE" | "DELETE", payload: Record<string, unknown>) {
  rt().deliver("emails", event, payload);
}

/** Recorded invalidateQueries calls whose key starts with `key`. */
function invalidationsOf(spy: { mock: { calls: unknown[][] } }, key: string) {
  return spy.mock.calls.filter(
    (call) => (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0] === key,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  rt().reset();
  frames.length = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => frames.splice(0, frames.length));
});

/** Mount, let the async connect resolve, and report SUBSCRIBED. */
async function mountSubscribed() {
  const ctx = mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  act(() => rt().status("SUBSCRIBED"));
  ctx.setQueryData.mockClear();
  ctx.invalidateQueries.mockClear();
  return ctx;
}

describe("useEmailRealtime — event batching", () => {
  it("collapses a burst of inserts into one cache write and one folder-count invalidation", async () => {
    const ctx = await mountSubscribed();
    ctx.qc.setQueryData(INBOX_KEY, [emailRow({ id: "existing" })]);
    ctx.setQueryData.mockClear();

    act(() => {
      for (const id of ["new-1", "new-2", "new-3"]) {
        deliver("INSERT", {
          new: emailRow({ id, received_at: `2026-09-02T11:00:0${id.at(-1)}Z` }),
        });
      }
    });
    expect(ctx.setQueryData).not.toHaveBeenCalled();
    act(() => runFrames());

    expect(ctx.setQueryData).toHaveBeenCalledTimes(1);
    expect(invalidationsOf(ctx.invalidateQueries, "folder-counts")).toHaveLength(1);
    expect(ctx.qc.getQueryData<EmailRow[]>(INBOX_KEY)?.map((r) => r.id)).toStrictEqual([
      "new-3",
      "new-2",
      "new-1",
      "existing",
    ]);
  });

  it("keeps the newest event for a row when several arrive in one frame", async () => {
    const ctx = await mountSubscribed();
    ctx.qc.setQueryData(INBOX_KEY, []);

    act(() => {
      deliver("INSERT", { new: emailRow({ id: "row-1" }) });
      deliver("DELETE", { old: { id: "row-1" } });
    });
    act(() => runFrames());

    expect(ctx.qc.getQueryData<EmailRow[]>(INBOX_KEY)).toStrictEqual([]);
  });

  it("only touches the lists a row belongs to", async () => {
    const ctx = await mountSubscribed();
    const otherKey = ["emails", "acct-2", "all", "page:0"] as const;
    ctx.qc.setQueryData(INBOX_KEY, []);
    ctx.qc.setQueryData(otherKey, []);

    act(() => deliver("INSERT", { new: emailRow({ id: "row-1" }) }));
    act(() => runFrames());

    expect(ctx.qc.getQueryData<EmailRow[]>(INBOX_KEY)?.map((r) => r.id)).toStrictEqual(["row-1"]);
    expect(ctx.qc.getQueryData<EmailRow[]>(otherKey)).toStrictEqual([]);
  });

  it("patches a paginated cache entry in place", async () => {
    const ctx = await mountSubscribed();
    ctx.qc.setQueryData(INBOX_KEY, {
      rows: [emailRow({ id: "row-1", is_archived: false })],
      total: 1,
    });

    act(() =>
      deliver("UPDATE", { new: emailRow({ id: "row-1", is_archived: true, raw_labels: [] }) }),
    );
    act(() => runFrames());

    expect(ctx.qc.getQueryData<{ rows: EmailRow[]; total: number }>(INBOX_KEY)).toStrictEqual({
      rows: [],
      total: 1,
    });
  });

  it("lets an AI-filed row dwell as settled-out, then sweeps it after the dwell", async () => {
    const ctx = await mountSubscribed();
    ctx.qc.setQueryData(INBOX_KEY, [emailRow({ id: "row-1", classified_by: "pending_ai" })]);

    // AI filed it: the Gmail INBOX label is gone, so it no longer belongs.
    act(() =>
      deliver("UPDATE", {
        new: emailRow({
          id: "row-1",
          classified_by: "ai",
          folder_id: "folder-1",
          raw_labels: ["Label_1"],
        }),
      }),
    );
    act(() => runFrames());

    expect(
      ctx.qc.getQueryData<EmailRow[]>(INBOX_KEY)?.map((r) => [r.id, r._settledOut]),
    ).toStrictEqual([["row-1", true]]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    act(() => runFrames());

    expect(ctx.qc.getQueryData<EmailRow[]>(INBOX_KEY)).toStrictEqual([]);
  });

  it("re-fetches instead of patching when a push arrives damaged", async () => {
    const ctx = await mountSubscribed();
    ctx.qc.setQueryData(INBOX_KEY, []);

    act(() => {
      deliver("INSERT", { errors: ["payload too large"], new: null });
      deliver("UPDATE", { errors: ["payload too large"], new: null });
    });
    act(() => runFrames());

    // Nothing was spliced into the list from an unusable payload…
    expect(ctx.qc.getQueryData<EmailRow[]>(INBOX_KEY)).toStrictEqual([]);
    expect(invalidationsOf(ctx.invalidateQueries, "emails")).toHaveLength(0);

    // …and the burst costs ONE round trip, once the coalescing window closes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(invalidationsOf(ctx.invalidateQueries, "emails")).toHaveLength(1);
    expect(invalidationsOf(ctx.invalidateQueries, "folder-counts")).toHaveLength(1);
  });

  it("refreshes the folder queries when a folder row changes", async () => {
    const ctx = await mountSubscribed();

    act(() => {
      rt().deliver("folders", "*", { new: { id: "folder-1" } });
    });

    expect(invalidationsOf(ctx.invalidateQueries, "folders")).toHaveLength(1);
    expect(invalidationsOf(ctx.invalidateQueries, "folders-full")).toHaveLength(1);
    expect(invalidationsOf(ctx.invalidateQueries, "emails")).toHaveLength(1);
    expect(invalidationsOf(ctx.invalidateQueries, "folder-counts")).toHaveLength(1);
  });
});

describe("useEmailRealtime — subscription lifecycle", () => {
  it("subscribes to the signed-in user's rows only", async () => {
    await mountSubscribed();

    expect(channel().handlers.map((h) => [h.config.table, h.config.event])).toStrictEqual([
      ["emails", "INSERT"],
      ["emails", "UPDATE"],
      ["emails", "DELETE"],
      ["folders", "*"],
    ]);
    for (const { config } of channel().handlers) {
      expect(config.filter).toBe("user_id=eq.user-1");
    }
  });

  it("catches up on SUBSCRIBED", async () => {
    const ctx = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    ctx.invalidateQueries.mockClear();

    act(() => rt().status("SUBSCRIBED"));

    expect(invalidationsOf(ctx.invalidateQueries, "emails")).toHaveLength(1);
    expect(invalidationsOf(ctx.invalidateQueries, "folders")).toHaveLength(1);
    expect(invalidationsOf(ctx.invalidateQueries, "folder-counts")).toHaveLength(1);
  });

  it("removes the channel and drops every pending timer on unmount", async () => {
    const ctx = await mountSubscribed();
    ctx.qc.setQueryData(INBOX_KEY, [emailRow({ id: "row-1", classified_by: "pending_ai" })]);
    // Leave a settle-sweep timer and an unflushed frame outstanding.
    act(() => deliver("UPDATE", { new: emailRow({ id: "row-1", classified_by: "ai" }) }));
    act(() => runFrames());
    act(() => deliver("INSERT", { new: emailRow({ id: "row-2" }) }));

    ctx.setQueryData.mockClear();
    ctx.invalidateQueries.mockClear();
    act(() => ctx.view.unmount());

    expect(rt().removed).toStrictEqual([channel()]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    act(() => runFrames());
    expect(ctx.setQueryData).not.toHaveBeenCalled();
    expect(ctx.invalidateQueries).not.toHaveBeenCalled();
  });
});
