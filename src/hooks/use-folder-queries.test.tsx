// Tests for the shared "folders-full" / "gmail-labels" query hooks.
//
// Contracts under test:
//   * query keys are ["folders-full", id] / ["gmail-labels", id] — the shell
//     and the inbox route share one cache entry per account,
//   * both hooks are disabled (no fetch at all) without an account id,
//   * folders are selected with FOLDER_COLUMNS (not "*") and a null data
//     payload becomes an empty array,
//   * a failed label fetch is swallowed into [] — labels are an enhancement
//     and must never error the surrounding screen.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { FOLDER_COLUMNS } from "@/components/folders/editor/types";

// Chainable supabase fake: from().select().eq().order() resolves rowsResult.
const order = vi.fn(async () => rowsResult);
const eq = vi.fn(() => ({ order }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn((_table: string) => ({ select }));
let rowsResult: { data: unknown[] | null } = { data: [] };

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => from(table) },
}));

// useServerFn needs a router; identity is enough for these hooks.
vi.mock("@tanstack/react-start", () => ({
  useServerFn: <T,>(fn: T) => fn,
}));

const listGmailLabels = vi.fn();
vi.mock("@/lib/gmail.functions", () => ({
  listGmailLabels: (...args: unknown[]) => listGmailLabels(...args),
}));

import { useFoldersFullQuery, useGmailLabelsQuery } from "./use-folder-queries";

beforeEach(() => {
  // The global teardown restores spies only; vi.fn call history must be
  // cleared here or "not called" assertions see earlier tests' calls.
  vi.clearAllMocks();
  rowsResult = { data: [] };
});

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe("useFoldersFullQuery", () => {
  it("fetches folders with FOLDER_COLUMNS, ordered by name, cached under ['folders-full', id]", async () => {
    const rows = [
      { id: "f1", name: "Alpha" },
      { id: "f2", name: "Beta" },
    ];
    rowsResult = { data: rows };
    const { queryClient, wrapper } = createWrapper();

    const { result } = renderHook(() => useFoldersFullQuery("acct-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(from).toHaveBeenCalledWith("folders");
    expect(select).toHaveBeenCalledWith(FOLDER_COLUMNS);
    expect(eq).toHaveBeenCalledWith("gmail_account_id", "acct-1");
    expect(order).toHaveBeenCalledWith("name", { ascending: true });
    // The shared cache entry both call sites read.
    expect(queryClient.getQueryData(["folders-full", "acct-1"])).toEqual(rows);
  });

  it("returns an empty array when supabase hands back null data", async () => {
    rowsResult = { data: null };
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useFoldersFullQuery("acct-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it("does not fetch at all without an account id", () => {
    rowsResult = { data: [] };
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useFoldersFullQuery(null), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.isPending).toBe(true);
    expect(from).not.toHaveBeenCalled();
  });
});

describe("useGmailLabelsQuery", () => {
  it("unwraps .labels from the server fn and caches under ['gmail-labels', id]", async () => {
    const labels = [{ id: "L1", name: "Receipts", type: "user" }];
    listGmailLabels.mockResolvedValueOnce({ labels });
    const { queryClient, wrapper } = createWrapper();

    const { result } = renderHook(() => useGmailLabelsQuery("acct-9"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(labels);
    expect(listGmailLabels).toHaveBeenCalledWith({ data: { account_id: "acct-9" } });
    expect(queryClient.getQueryData(["gmail-labels", "acct-9"])).toEqual(labels);
  });

  it("swallows a failed label fetch into an empty list instead of erroring", async () => {
    listGmailLabels.mockRejectedValueOnce(new Error("gmail down"));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useGmailLabelsQuery("acct-9"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
    expect(result.current.isError).toBe(false);
  });

  it("does not call the server fn without an account id", () => {
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useGmailLabelsQuery(undefined), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(listGmailLabels).not.toHaveBeenCalled();
  });
});
