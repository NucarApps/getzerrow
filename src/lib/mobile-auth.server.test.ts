// authenticateRequest's contract is THROWN Response objects (401/500) so the
// mobile route handlers can `catch (r) { return r }`. Every rejection is
// asserted as an actual Response instance with the right status.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));

import { createClient } from "@supabase/supabase-js";
import { authenticateRequest } from "./mobile-auth.server";

function reqWith(headers: Record<string, string>): Request {
  // Plain header bag: real Request headers trim trailing whitespace, which
  // would hide the empty-token-after-"Bearer " branch.
  return {
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  } as unknown as Request;
}

function stubClient(claimsResult: { data?: unknown; error?: unknown }) {
  const getClaims = vi.fn(async () => claimsResult as never);
  const client = { auth: { getClaims } };
  vi.mocked(createClient).mockReturnValue(client as never);
  return { client, getClaims };
}

async function expectThrownResponse(p: Promise<unknown>, status: number): Promise<Response> {
  const thrown = await p.then(
    () => {
      throw new Error(`expected a thrown Response ${status}, but the promise resolved`);
    },
    (r: unknown) => r,
  );
  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).status).toBe(status);
  return thrown as Response;
}

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.mocked(createClient).mockReset();
});

describe("authenticateRequest", () => {
  it("throws a 500 Response when server env is not configured", async () => {
    vi.stubEnv("SUPABASE_URL", undefined);
    await expectThrownResponse(authenticateRequest(reqWith({ authorization: "Bearer t" })), 500);
  });

  it("throws a 401 Response when the authorization header is missing", async () => {
    await expectThrownResponse(authenticateRequest(reqWith({})), 401);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("throws a 401 Response for non-Bearer schemes", async () => {
    await expectThrownResponse(
      authenticateRequest(reqWith({ authorization: "Basic dXNlcjpwYXNz" })),
      401,
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it("throws a 401 Response when the Bearer token is empty after trimming", async () => {
    await expectThrownResponse(authenticateRequest(reqWith({ authorization: "Bearer    " })), 401);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("throws a 401 Response when getClaims rejects the token or omits sub", async () => {
    stubClient({ data: null, error: { message: "expired" } });
    await expectThrownResponse(
      authenticateRequest(reqWith({ authorization: "Bearer bad-token" })),
      401,
    );
    stubClient({ data: { claims: { email: "x@y.z" } }, error: null });
    await expectThrownResponse(
      authenticateRequest(reqWith({ authorization: "Bearer no-sub" })),
      401,
    );
  });

  it("returns { userId, token, supabase } with the token trimmed on success", async () => {
    const { client, getClaims } = stubClient({
      data: { claims: { sub: "user-7" } },
      error: null,
    });
    const auth = await authenticateRequest(reqWith({ authorization: "Bearer  tok-123  " }));
    expect(auth).toEqual({ userId: "user-7", token: "tok-123", supabase: client });
    expect(getClaims).toHaveBeenCalledWith("tok-123");
    // The user-scoped client never persists a session server-side.
    const [, , options] = vi.mocked(createClient).mock.calls[0] as unknown as [
      string,
      string,
      { auth: Record<string, unknown> },
    ];
    expect(options.auth.persistSession).toBe(false);
  });
});
