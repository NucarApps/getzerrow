// Tests for the shared Google OAuth reconnect starter.
//
// Contracts under test:
//   * login_hint is sent only when a hint is given (empty {} otherwise),
//   * on success the browser is sent to the returned URL and true comes back,
//   * on failure it toasts (caller message wins over the error's) and
//     returns false so callers can clear their busy state.
//
// jsdom can't perform real navigation, so the mocked server fn returns the
// current page URL plus a hash — a hash change is the one navigation jsdom
// implements, letting the `window.location.href = url` assignment be observed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@tanstack/react-start", () => ({
  useServerFn: <T,>(fn: T) => fn,
}));

const startConnectGmail = vi.fn();
vi.mock("@/lib/gmail.functions", () => ({
  startConnectGmail: (...args: unknown[]) => startConnectGmail(...args),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

import { useGoogleReconnect } from "./use-google-reconnect";

const pageUrl = () => window.location.href.split("#")[0];

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
});

describe("useGoogleReconnect", () => {
  it("starts the redirect without a login hint and reports success", async () => {
    startConnectGmail.mockResolvedValueOnce({ url: `${pageUrl()}#oauth-started` });
    const { result } = renderHook(() => useGoogleReconnect());

    const ok = await result.current({});

    expect(ok).toBe(true);
    expect(startConnectGmail).toHaveBeenCalledWith({ data: {} });
    expect(window.location.hash).toBe("#oauth-started");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("passes the login hint through so Google preselects the account", async () => {
    startConnectGmail.mockResolvedValueOnce({ url: `${pageUrl()}#oauth-hinted` });
    const { result } = renderHook(() => useGoogleReconnect());

    const ok = await result.current({ loginHint: "serg@example.com" });

    expect(ok).toBe(true);
    expect(startConnectGmail).toHaveBeenCalledWith({
      data: { login_hint: "serg@example.com" },
    });
    expect(window.location.hash).toBe("#oauth-hinted");
  });

  it("toasts the thrown error's message and returns false when the redirect can't start", async () => {
    startConnectGmail.mockRejectedValueOnce(new Error("token exchange refused"));
    const { result } = renderHook(() => useGoogleReconnect());

    const ok = await result.current({});

    expect(ok).toBe(false);
    expect(toastError).toHaveBeenCalledWith("token exchange refused");
    expect(window.location.hash).toBe("");
  });

  it("prefers the caller's error message, and falls back to a generic one for non-Errors", async () => {
    startConnectGmail.mockRejectedValueOnce(new Error("token exchange refused"));
    const { result } = renderHook(() => useGoogleReconnect());
    expect(await result.current({ errorMessage: "Couldn't reconnect this inbox" })).toBe(false);
    expect(toastError).toHaveBeenLastCalledWith("Couldn't reconnect this inbox");

    startConnectGmail.mockRejectedValueOnce("nope");
    expect(await result.current({})).toBe(false);
    expect(toastError).toHaveBeenLastCalledWith("Couldn't start Google sign-in");
  });
});
