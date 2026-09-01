// selfBaseUrl / kickHook (src/lib/self-url.server.ts): the deployment
// origin used when a server fn calls back into its own public hooks with
// the cron secret. Pinned: an explicit APP_BASE_URL always wins; the request
// host is only used when it is a bare hostname; a missing base or secret
// means no request is sent at all (the secret never goes anywhere odd).

import { describe, it, expect, vi, beforeEach } from "vitest";

const getRequestHost = vi.fn<() => string | undefined>();
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHost: () => getRequestHost(),
}));

import { selfBaseUrl, kickHook } from "./self-url.server";

beforeEach(() => {
  vi.stubEnv("APP_BASE_URL", undefined);
  vi.stubEnv("CRON_SECRET", undefined);
  getRequestHost.mockReturnValue("app.example.com");
});

describe("selfBaseUrl", () => {
  it("prefers APP_BASE_URL (trailing slash stripped) over the request host", () => {
    vi.stubEnv("APP_BASE_URL", "https://zerrow.app/");
    expect(selfBaseUrl()).toBe("https://zerrow.app");
  });

  it("falls back to https://<request host> for a bare hostname (with optional port)", () => {
    expect(selfBaseUrl()).toBe("https://app.example.com");
    getRequestHost.mockReturnValue("localhost:3000");
    expect(selfBaseUrl()).toBe("https://localhost:3000");
  });

  it.each(["evil.example/../", "user:pw@evil.example", "evil.example/path", "evil.example ", ""])(
    "rejects a request host that is not a plain hostname: %j",
    (host) => {
      getRequestHost.mockReturnValue(host);
      expect(selfBaseUrl()).toBeNull();
    },
  );

  it("returns null when there is no request context at all", () => {
    getRequestHost.mockImplementation(() => {
      throw new Error("no request");
    });
    expect(selfBaseUrl()).toBeNull();
  });
});

describe("kickHook", () => {
  it("POSTs to <base><path> with the cron secret as a Bearer token", async () => {
    vi.stubEnv("APP_BASE_URL", "https://zerrow.app");
    vi.stubEnv("CRON_SECRET", "s3cret");
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const kicked = await kickHook("api/public/hooks/google-contacts-sync", {
      body: { a: 1 },
      keepalive: true,
    });
    expect(kicked?.url).toBe("https://zerrow.app/api/public/hooks/google-contacts-sync");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://zerrow.app/api/public/hooks/google-contacts-sync",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
        body: '{"a":1}',
        keepalive: true,
      },
    );
  });

  it("sends nothing when the secret is missing", async () => {
    vi.stubEnv("APP_BASE_URL", "https://zerrow.app");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await kickHook("/x")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing when the base URL cannot be established", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    getRequestHost.mockReturnValue("bad host/with/path");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await kickHook("/x")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
