// Tests for useContactsRealtime (src/lib/use-contacts-realtime.ts).
//
// The hook is invalidation-only, so its whole job is: which query keys go
// stale, and how often. A missing key leaves an open contact drawer showing
// data another device already changed; a missing debounce turns a CardDAV
// import into one refetch per row.
//
// The connection lifecycle it shares with the inbox hook is covered in
// ui/realtime-coalescer.test.ts; this file covers the contacts-specific part.

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

function rt() {
  if (!box.rt) throw new Error("realtime fake was never installed");
  return box.rt;
}

import { useContactsRealtime } from "./use-contacts-realtime";

/** Every key the contacts book derives from a contact row. */
const REFRESHED_KEYS = [
  "contacts",
  "contact",
  "contact-groups",
  "companies",
  "company-aliases",
  "company-logo-choices",
];

function invalidatedKeys(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map(
    (call) => (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0],
  );
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateQueries = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useContactsRealtime(), { wrapper });
  return { qc, invalidateQueries, view };
}

async function mountSubscribed() {
  const ctx = mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  act(() => rt().status("SUBSCRIBED"));
  ctx.invalidateQueries.mockClear();
  return ctx;
}

beforeEach(() => {
  vi.useFakeTimers();
  rt().reset();
});

describe("useContactsRealtime", () => {
  it("subscribes to every change on the signed-in user's contacts", async () => {
    await mountSubscribed();

    expect(
      rt()
        .latest()
        .handlers.map((h) => h.config),
    ).toStrictEqual([
      { event: "*", schema: "public", table: "contacts", filter: "user_id=eq.user-1" },
    ]);
  });

  it("refreshes every derived query on the catch-up after SUBSCRIBED", async () => {
    const ctx = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    ctx.invalidateQueries.mockClear();

    act(() => rt().status("SUBSCRIBED"));

    expect(invalidatedKeys(ctx.invalidateQueries)).toStrictEqual(REFRESHED_KEYS);
  });

  it("debounces a burst of row changes into a single refresh", async () => {
    const ctx = await mountSubscribed();

    act(() => {
      for (let i = 0; i < 25; i++) rt().deliver("contacts", "*", { new: { id: `c-${i}` } });
    });
    // Still nothing: the debounce is trailing, so an import does not cost a
    // refetch per row.
    expect(ctx.invalidateQueries).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(invalidatedKeys(ctx.invalidateQueries)).toStrictEqual(REFRESHED_KEYS);
  });

  it("refreshes when the tab becomes visible again", async () => {
    const ctx = await mountSubscribed();

    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(invalidatedKeys(ctx.invalidateQueries)).toStrictEqual(REFRESHED_KEYS);
  });

  it("removes the channel and drops a pending debounce on unmount", async () => {
    const ctx = await mountSubscribed();
    act(() => rt().deliver("contacts", "*", { new: { id: "c-1" } }));

    const channel = rt().latest();
    act(() => ctx.view.unmount());

    expect(rt().removed).toStrictEqual([channel]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(ctx.invalidateQueries).not.toHaveBeenCalled();
  });
});
