// Tests for the (auto-generated, never edited) requireSupabaseAuth middleware.
// createMiddleware is mocked so `.server(fn)` returns the raw handler — the
// exported `requireSupabaseAuth` then IS the async ({ next }) function, which
// we drive directly with a mocked getRequest and a spy Supabase client.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (fn: unknown) => fn }),
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));

import { getRequest } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "./auth-middleware";

type Handler = (ctx: { next: ReturnType<typeof vi.fn> }) => Promise<unknown>;
const handler = requireSupabaseAuth as unknown as Handler;

const URL_ENV = "https://project.supabase.co";
const KEY_ENV = "publishable-key";
const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"] as const;
let savedEnv: Record<string, string | undefined>;

function stubRequest(headers: Record<string, string> | null) {
  // A plain header bag (not a real Request): the Fetch spec strips trailing
  // whitespace from header values, which would make "Bearer " untestable.
  const req =
    headers === null
      ? undefined
      : { headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } };
  vi.mocked(getRequest).mockReturnValue(req as unknown as Request);
}

function stubClient(claimsResult: { data?: unknown; error?: unknown }) {
  const getClaims = vi.fn(async () => claimsResult as never);
  const client = { auth: { getClaims } };
  vi.mocked(createClient).mockReturnValue(client as never);
  return { client, getClaims };
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.SUPABASE_URL = URL_ENV;
  process.env.SUPABASE_PUBLISHABLE_KEY = KEY_ENV;
  vi.mocked(createClient).mockReset();
  vi.mocked(getRequest).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

describe("requireSupabaseAuth", () => {
  it("names every missing Supabase env var in the error", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
    await expect(handler({ next: vi.fn() })).rejects.toThrow(
      /SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY/,
    );
  });

  it("names only the single missing env var", async () => {
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
    const err = await handler({ next: vi.fn() }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("SUPABASE_PUBLISHABLE_KEY");
    expect((err as Error).message).not.toContain("SUPABASE_URL,");
  });

  it("rejects when no request is available", async () => {
    stubRequest(null);
    await expect(handler({ next: vi.fn() })).rejects.toThrow(
      "Unauthorized: No request headers available",
    );
  });

  it("rejects a request with no authorization header", async () => {
    stubRequest({});
    await expect(handler({ next: vi.fn() })).rejects.toThrow(
      "Unauthorized: No authorization header provided",
    );
  });

  it("rejects non-Bearer schemes (Basic must not pass)", async () => {
    stubRequest({ authorization: "Basic dXNlcjpwYXNz" });
    await expect(handler({ next: vi.fn() })).rejects.toThrow(
      "Unauthorized: Only Bearer tokens are supported",
    );
  });

  it("rejects an empty Bearer token", async () => {
    stubRequest({ authorization: "Bearer " });
    await expect(handler({ next: vi.fn() })).rejects.toThrow("Unauthorized: No token provided");
  });

  it("rejects when getClaims errors or returns no claims", async () => {
    stubRequest({ authorization: "Bearer some-token" });
    stubClient({ data: null, error: { message: "bad token" } });
    await expect(handler({ next: vi.fn() })).rejects.toThrow("Unauthorized: Invalid token");

    stubClient({ data: { claims: null }, error: null });
    await expect(handler({ next: vi.fn() })).rejects.toThrow("Unauthorized: Invalid token");
  });

  it("rejects claims without a sub (no user id)", async () => {
    stubRequest({ authorization: "Bearer some-token" });
    stubClient({ data: { claims: { email: "x@y.z" } }, error: null });
    await expect(handler({ next: vi.fn() })).rejects.toThrow(
      "Unauthorized: No user ID found in token",
    );
  });

  it("on success passes userId + claims + client to next, building a per-request client", async () => {
    stubRequest({ authorization: "Bearer valid-token" });
    const claims = { sub: "user-42", email: "u@example.com" };
    const { client, getClaims } = stubClient({ data: { claims }, error: null });
    const next = vi.fn(async (opts: unknown) => opts);

    await handler({ next });

    // The user-scoped client must forward the caller's token and never
    // persist a session server-side.
    expect(createClient).toHaveBeenCalledTimes(1);
    const [url, key, options] = vi.mocked(createClient).mock.calls[0] as unknown as [
      string,
      string,
      { global: { headers: Record<string, string> }; auth: Record<string, unknown> },
    ];
    expect(url).toBe(URL_ENV);
    expect(key).toBe(KEY_ENV);
    expect(options.global.headers.Authorization).toBe("Bearer valid-token");
    expect(options.auth.persistSession).toBe(false);
    expect(options.auth.autoRefreshToken).toBe(false);

    expect(getClaims).toHaveBeenCalledWith("valid-token");
    expect(next).toHaveBeenCalledWith({
      context: { supabase: client, userId: "user-42", claims },
    });
  });
});
