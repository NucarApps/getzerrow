// In-process tests for the CardDAV splat route — the dispatcher every
// iPhone request passes through before any handler sees it. Same style as
// cron-auth.test.ts: import the route module and invoke
// Route.options.server.handlers.X({ request, params }) directly.
//
// What the route itself owns (and nothing below it can enforce):
//   * OPTIONS answers the DAV discovery probe WITHOUT credentials — iOS
//     sends it before it has any, and a 401 here stalls account setup;
//   * every other method authenticates first, and the 401 must carry the
//     Basic challenge or iOS never prompts for the app password;
//   * bodies are capped by Content-Length before a byte is read into the
//     Worker isolate;
//   * unsupported WebDAV verbs answer 405 with an Allow header rather than
//     falling through to a handler;
//   * the post-sync photo backfill is debounced per user — iPhone fires
//     REPORT several times per sync and the backfill walks every account.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

const verifyCardDavAuth =
  vi.fn<
    (
      request: Request,
    ) => Promise<{ ok: true; userId: string; email: string } | { ok: false; response: Response }>
  >();
const autoClearMissingPhotoEtags = vi.fn<(userId: string, accountId: string) => Promise<void>>();

// Property accesses are deferred into method bodies so the hoisted factories
// never touch the module-scope consts before their initializers run.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));
vi.mock("@/lib/carddav/auth.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/carddav/auth.server")>(
    "@/lib/carddav/auth.server",
  );
  return {
    ...actual,
    verifyCardDavAuth: (request: Request) => verifyCardDavAuth(request),
  };
});
vi.mock("@/lib/google-contacts/reconcile.server", () => ({
  autoClearMissingPhotoEtags: (userId: string, accountId: string) =>
    autoClearMissingPhotoEtags(userId, accountId),
}));

import { Route } from "./$";
import { carddavAuthChallengeResponse } from "@/lib/carddav/auth.server";

type Handler = (ctx: {
  request: Request;
  params: Record<string, string | undefined>;
}) => Promise<Response>;

const handlers = Route.options.server!.handlers as unknown as Record<string, Handler>;

const EMAIL = "ios@example.com";
const BASE = "https://app.test/api/public/carddav";
const ACCOUNT_A = "acct-a";
const ACCOUNT_B = "acct-b";

/** Each test that reaches the debounce uses its own user id: the debounce
 * map is module state and outlives a single test. */
let userSeq = 0;
function nextUser(): string {
  userSeq += 1;
  return `user-${userSeq}`;
}

function call(
  method: string,
  opts: { splat?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  const splat = opts.splat ?? `${EMAIL}/contacts/`;
  const request = new Request(`${BASE}/${splat}`, {
    method,
    headers: opts.headers,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
  const handler = handlers[method] ?? handlers.ANY;
  if (!handler) throw new Error(`no handler for ${method}`);
  return handler({ request, params: { _splat: splat } });
}

/** Drain the microtask queue so a fire-and-forget backfill (dynamic imports
 * plus a couple of awaited queries) has run if it was going to. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function authAs(userId: string): void {
  verifyCardDavAuth.mockResolvedValue({ ok: true, userId, email: EMAIL });
}

/** Seed the minimum a REPORT needs so it can answer without exploding. */
function seedEmptyBook(userId: string): void {
  fake.seed("contacts", []);
  fake.seed("contact_groups", []);
  fake.seed("carddav_tombstones", []);
  fake.seed("carddav_settings", [{ user_id: userId, resync_nonce: 0, group_name_style: "leaf" }]);
}

beforeEach(() => {
  fake.reset();
  verifyCardDavAuth.mockResolvedValue({ ok: false, response: carddavAuthChallengeResponse() });
  autoClearMissingPhotoEtags.mockResolvedValue(undefined);
});

describe("method routing", () => {
  it("exposes GET/HEAD/OPTIONS plus an ANY catch-all for the WebDAV verbs", () => {
    // PROPFIND and REPORT are the bulk of CardDAV traffic and cannot be
    // named as handler keys, so ANY has to exist.
    expect(Object.keys(handlers).sort()).toEqual(["ANY", "GET", "HEAD", "OPTIONS"]);
  });
});

describe("OPTIONS", () => {
  it("answers the discovery probe without credentials", async () => {
    // iOS sends OPTIONS before it has an app password. A 401 here shows up
    // as "cannot connect to server" rather than a password prompt.
    const res = await call("OPTIONS", { splat: "" });
    expect(res.status).toBe(200);
    expect(res.headers.get("DAV")).toBe("1, 3, addressbook");
    expect(res.headers.get("Allow")).toBe("OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT");
    expect(verifyCardDavAuth).not.toHaveBeenCalled();
  });
});

describe("authentication gate", () => {
  const guarded = ["PROPFIND", "REPORT", "GET", "HEAD", "PUT", "DELETE", "MKCOL"];

  for (const method of guarded) {
    it(`${method} without credentials returns 401 with the Basic challenge`, async () => {
      const res = await call(method);
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="Atzro CardDAV"');
      // Nothing below the gate ran.
      expect(fake.calls.selects).toEqual([]);
      expect(fake.calls.updates).toEqual([]);
      expect(autoClearMissingPhotoEtags).not.toHaveBeenCalled();
    });
  }

  it("passes the whole request to the verifier so it can read the header itself", async () => {
    await call("PROPFIND", { headers: { authorization: "Basic bm9wZTpub3Bl" } });
    const seen = verifyCardDavAuth.mock.calls[0]![0];
    expect(seen.headers.get("authorization")).toBe("Basic bm9wZTpub3Bl");
  });
});

describe("body cap", () => {
  it("rejects a 12 MB+ PUT on Content-Length alone, before reading the body", async () => {
    // The cap exists so a malicious client cannot stream an arbitrarily
    // large body into the Worker isolate. 12 MB leaves room for a 5 MB
    // photo base64-encoded plus vCard overhead.
    authAs(nextUser());
    const res = await call("PUT", {
      splat: `${EMAIL}/contacts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.vcf`,
      headers: { "content-length": String(12 * 1024 * 1024 + 1) },
      body: "BEGIN:VCARD",
    });
    expect(res.status).toBe(413);
    expect(fake.calls.selects).toEqual([]);
  });

  it("rejects an unparseable Content-Length rather than trusting it", async () => {
    authAs(nextUser());
    const res = await call("REPORT", {
      headers: { "content-length": "not-a-number" },
      body: "<D:sync-collection/>",
    });
    expect(res.status).toBe(413);
  });

  it("allows a body exactly at the cap", async () => {
    const userId = nextUser();
    authAs(userId);
    seedEmptyBook(userId);
    const res = await call("REPORT", {
      headers: { "content-length": String(12 * 1024 * 1024) },
      body: '<?xml version="1.0"?><D:unknown xmlns:D="DAV:"/>',
    });
    expect(res.status).toBe(207);
  });

  it("does not cap the methods that never read a body", async () => {
    const userId = nextUser();
    authAs(userId);
    fake.seed("contacts", []);
    const res = await call("GET", {
      splat: `${EMAIL}/contacts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.vcf`,
      headers: { "content-length": String(50 * 1024 * 1024) },
    });
    expect(res.status).toBe(404);
  });
});

describe("unsupported WebDAV verbs", () => {
  for (const method of ["MKCOL", "COPY", "MOVE", "LOCK", "PROPPATCH"]) {
    it(`${method} returns 405 advertising the methods that do work`, async () => {
      // A bare 405 makes some clients retry forever; the Allow header tells
      // them what the collection actually supports.
      authAs(nextUser());
      const res = await call(method);
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT");
    });
  }
});

describe("post-sync photo backfill", () => {
  beforeEach(() => {
    fake.seed("gmail_accounts", []);
  });

  async function reportOnce(userId: string): Promise<void> {
    seedEmptyBook(userId);
    fake.seed("gmail_accounts", [
      { id: ACCOUNT_A, user_id: userId },
      { id: ACCOUNT_B, user_id: userId },
    ]);
    authAs(userId);
    const res = await call("REPORT", { body: '<?xml version="1.0"?><D:unknown xmlns:D="DAV:"/>' });
    expect(res.status).toBe(207);
  }

  it("clears stale photo etags for every account under the syncing user", async () => {
    const userId = nextUser();
    await reportOnce(userId);
    await vi.waitFor(() => expect(autoClearMissingPhotoEtags).toHaveBeenCalledTimes(2));
    expect(autoClearMissingPhotoEtags.mock.calls).toEqual([
      [userId, ACCOUNT_A],
      [userId, ACCOUNT_B],
    ]);
  });

  it("debounces repeat REPORTs inside the one-minute window", async () => {
    // A single iPhone sync fires REPORT several times (one per address book,
    // plus multigets). Without the debounce each one would walk every Gmail
    // account under the user.
    vi.useFakeTimers({ now: new Date("2026-08-01T09:00:00.000Z") });
    const userId = nextUser();

    await reportOnce(userId);
    await vi.waitFor(() => expect(autoClearMissingPhotoEtags).toHaveBeenCalledTimes(2));

    vi.setSystemTime(new Date("2026-08-01T09:00:59.000Z"));
    await reportOnce(userId);
    // The backfill is fire-and-forget, so give a suppressed one every chance
    // to show up before concluding it did not run.
    await flushMicrotasks();
    expect(autoClearMissingPhotoEtags).toHaveBeenCalledTimes(2);

    // Past the window it runs again.
    vi.setSystemTime(new Date("2026-08-01T09:01:01.000Z"));
    await reportOnce(userId);
    await vi.waitFor(() => expect(autoClearMissingPhotoEtags).toHaveBeenCalledTimes(4));
  });

  it("debounces per user, so one busy phone cannot starve another account", async () => {
    const first = nextUser();
    const second = nextUser();
    await reportOnce(first);
    await vi.waitFor(() => expect(autoClearMissingPhotoEtags).toHaveBeenCalledTimes(2));

    await reportOnce(second);
    await vi.waitFor(() => expect(autoClearMissingPhotoEtags).toHaveBeenCalledTimes(4));
    expect(autoClearMissingPhotoEtags.mock.calls.map(([u]) => u)).toEqual([
      first,
      first,
      second,
      second,
    ]);
  });

  it("a failing backfill never touches the response the client already got", async () => {
    const userId = nextUser();
    autoClearMissingPhotoEtags.mockRejectedValue(new Error("reconcile down"));
    await reportOnce(userId);
    await vi.waitFor(() => expect(autoClearMissingPhotoEtags).toHaveBeenCalled());
  });

  it("does not run for an unauthenticated REPORT", async () => {
    await call("REPORT", { body: "<D:sync-collection/>" });
    expect(autoClearMissingPhotoEtags).not.toHaveBeenCalled();
  });
});
