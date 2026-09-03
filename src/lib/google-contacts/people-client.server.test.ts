// Unit tests for the People API client (google-contacts/people-client.server.ts).
// Pure `fetch` stubs — no network, no Supabase. Contracts pinned here:
//
//   - `call()`'s error taxonomy: a non-OK response becomes a PeopleApiError
//     carrying the HTTP status and Google's machine reason, and a transport
//     failure becomes status 0 (so a caller can tell "Google said no" from
//     "we never reached Google");
//   - the retry predicates the sync loop branches on — expired sync token,
//     etag conflict, missing scope;
//   - request shape: the field masks, the query parameters each endpoint
//     sends, and the 20 s abort budget every call carries;
//   - the two chunkers: base64 for a photo larger than one String.fromCharCode
//     apply window, and members:modify batched 500 at a time with the add and
//     remove lists kept aligned.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/google-oauth.server", () => ({
  getAccessToken: vi.fn(async () => "test-access-token"),
  CONTACTS_SCOPE: "https://www.googleapis.com/auth/contacts",
}));

import {
  PeopleApiError,
  listConnectionsPage,
  listContactGroupsPage,
  getPerson,
  createPerson,
  updatePerson,
  deletePerson,
  updateContactPhoto,
  deleteContactPhoto,
  fetchPhotoBytes,
  getContactGroupWithMembers,
  createContactGroup,
  updateContactGroup,
  deleteContactGroup,
  modifyGroupMembers,
} from "./people-client.server";
import { READ_PERSON_FIELDS, UPDATE_PERSON_FIELDS } from "./mapper";

type FetchCall = { url: URL; init: RequestInit };

/** Stub `fetch` with a single canned response and record every request. */
function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const call = { url: new URL(input), init };
      calls.push(call);
      return respond(call);
    }),
  );
  return calls;
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** The JSON body Google sends on an error, and the reason it carries. */
function googleError(status: string, reason?: string) {
  return JSON.stringify({
    error: {
      code: 400,
      message: "Request had invalid arguments.",
      status,
      ...(reason ? { errors: [{ reason }] } : {}),
    },
  });
}

function bodyOf(call: FetchCall | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body ?? "{}")) as Record<string, unknown>;
}

beforeEach(() => {
  stubFetch(() => ok({}));
});

describe("call() error taxonomy", () => {
  it("turns a non-OK response into a PeopleApiError with the status and Google's reason", async () => {
    stubFetch(() => new Response(googleError("NOT_FOUND", "notFound"), { status: 404 }));

    const err = await getPerson("acct-1", "people/c1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PeopleApiError);
    const people = err as PeopleApiError;
    expect(people.status).toBe(404);
    expect(people.googleReason).toBe("notFound");
    expect(people.name).toBe("PeopleApiError");
    expect(people.message).toContain("People API 404 on /people/c1");
  });

  it("falls back to error.status when Google sends no per-error reason", async () => {
    stubFetch(() => new Response(googleError("PERMISSION_DENIED"), { status: 403 }));

    const err = (await getPerson("acct-1", "people/c1").catch((e: unknown) => e)) as PeopleApiError;

    expect(err.googleReason).toBe("PERMISSION_DENIED");
  });

  it("leaves the reason null when the error body is not JSON", async () => {
    stubFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));

    const err = (await getPerson("acct-1", "people/c1").catch((e: unknown) => e)) as PeopleApiError;

    expect(err.status).toBe(502);
    expect(err.googleReason).toBeNull();
    expect(err.message).toContain("502 Bad Gateway");
  });

  it("caps the echoed body at 400 characters so a log line cannot be flooded", async () => {
    stubFetch(() => new Response("x".repeat(5000), { status: 500 }));

    const err = (await getPerson("acct-1", "people/c1").catch((e: unknown) => e)) as PeopleApiError;

    expect(err.message).toHaveLength("People API 500 on /people/c1: ".length + 400);
  });

  it("reports a transport failure as status 0, distinct from any HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const err = (await getPerson("acct-1", "people/c1").catch((e: unknown) => e)) as PeopleApiError;

    expect(err.status).toBe(0);
    expect(err.message).toBe("People API network error on /people/c1: fetch failed");
  });

  it("carries a 20 second abort budget on every request", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    stubFetch(() => ok({}));

    await getPerson("acct-1", "people/c1");

    expect(timeout).toHaveBeenCalledWith(20_000);
  });

  it("resolves an empty 200 body as an empty object rather than throwing", async () => {
    stubFetch(() => new Response("", { status: 200 }));

    await expect(deletePerson("acct-1", "people/c1")).resolves.toBeUndefined();
  });

  it("sends the OAuth bearer token and a JSON content type", async () => {
    const calls = stubFetch(() => ok({}));

    await getPerson("acct-1", "people/c1");

    expect(calls[0]?.init.headers).toStrictEqual({
      Authorization: "Bearer test-access-token",
      "Content-Type": "application/json",
    });
  });
});

describe("PeopleApiError retry predicates", () => {
  const err = (status: number, message: string, reason: string | null = null) =>
    new PeopleApiError(message, status, reason);

  it.each([
    ["EXPIRED_SYNC_TOKEN in the message", err(400, "… EXPIRED_SYNC_TOKEN …"), true],
    ["expired_sync_token, case-insensitively", err(400, "… expired_sync_token …"), true],
    ["the reason only", err(400, "Request had invalid arguments.", "EXPIRED_SYNC_TOKEN"), true],
    ["the wrong status", err(410, "EXPIRED_SYNC_TOKEN"), false],
    ["an unrelated 400", err(400, "INVALID_ARGUMENT"), false],
  ])("isExpiredSyncToken is %s → %s", (_label, error, expected) => {
    expect(error.isExpiredSyncToken).toBe(expected);
  });

  it.each([
    ["FAILED_PRECONDITION in the message", err(400, "… FAILED_PRECONDITION …"), true],
    ["the word etag", err(400, "… etag mismatch …"), true],
    ["the wrong status", err(412, "FAILED_PRECONDITION"), false],
    ["an unrelated 400", err(400, "INVALID_ARGUMENT"), false],
  ])("isEtagConflict is %s → %s", (_label, error, expected) => {
    expect(error.isEtagConflict).toBe(expected);
  });

  it.each([
    ["insufficient in the message", err(403, "… insufficient authentication scopes …"), true],
    ["the reason only", err(403, "Forbidden by policy.", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"), true],
    ["the wrong status", err(401, "insufficient scope"), false],
    ["an unrelated 403", err(403, "quota exceeded"), false],
  ])("isMissingScope is %s → %s", (_label, error, expected) => {
    expect(error.isMissingScope).toBe(expected);
  });

  // CHARACTERIZATION(etag-conflict-ignores-google-reason): isEtagConflict tests
  // only `message`, while its two siblings test message + googleReason. The
  // message is the body truncated to 400 chars, so a long error body pushes
  // Google's FAILED_PRECONDITION out of it and the etag retry never fires —
  // flip when fixed.
  it("misses an etag conflict whose marker only survives in googleReason", async () => {
    const padded = JSON.stringify({
      error: { code: 400, message: "y".repeat(600), status: "FAILED_PRECONDITION" },
    });
    stubFetch(() => new Response(padded, { status: 400 }));

    const error = (await updatePerson("acct-1", "people/c1", { etag: "old" }).catch(
      (e: unknown) => e,
    )) as PeopleApiError;

    expect(error.googleReason).toBe("FAILED_PRECONDITION");
    expect(error.message).not.toContain("FAILED_PRECONDITION");
    expect(error.isEtagConflict).toBe(false);
  });
});

describe("request shapes", () => {
  it("listConnectionsPage sends the read mask and the default page size", async () => {
    const calls = stubFetch(() => ok({ connections: [] }));

    await listConnectionsPage("acct-1", {});

    expect(calls[0]?.url.pathname).toBe("/v1/people/me/connections");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toStrictEqual({
      personFields: READ_PERSON_FIELDS,
      pageSize: "500",
    });
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("listConnectionsPage adds only the paging tokens it was given", async () => {
    const calls = stubFetch(() => ok({ connections: [] }));

    await listConnectionsPage("acct-1", {
      pageSize: 50,
      pageToken: "pt",
      syncToken: "st",
      requestSyncToken: true,
    });

    expect(Object.fromEntries(calls[0]!.url.searchParams)).toStrictEqual({
      personFields: READ_PERSON_FIELDS,
      pageSize: "50",
      pageToken: "pt",
      syncToken: "st",
      requestSyncToken: "true",
    });
  });

  it("createPerson POSTs the body and asks for the read mask back", async () => {
    const calls = stubFetch(() => ok({ resourceName: "people/new" }));

    const person = await createPerson("acct-1", { names: [{ givenName: "Ada" }] });

    expect(person).toStrictEqual({ resourceName: "people/new" });
    expect(calls[0]?.url.pathname).toBe("/v1/people:createContact");
    expect(calls[0]?.init.method).toBe("POST");
    expect(bodyOf(calls[0])).toStrictEqual({ names: [{ givenName: "Ada" }] });
    expect(calls[0]?.url.searchParams.get("personFields")).toBe(READ_PERSON_FIELDS);
  });

  it("updatePerson PATCHes with both masks and carries the etag through", async () => {
    const calls = stubFetch(() => ok({ resourceName: "people/c1" }));

    await updatePerson("acct-1", "people/c1", { etag: "etag-1" });

    expect(calls[0]?.url.pathname).toBe("/v1/people/c1:updateContact");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.url.searchParams.get("updatePersonFields")).toBe(UPDATE_PERSON_FIELDS);
    expect(calls[0]?.url.searchParams.get("personFields")).toBe(READ_PERSON_FIELDS);
    expect(bodyOf(calls[0])).toStrictEqual({ etag: "etag-1" });
  });

  it("deletePerson and deleteContactPhoto use DELETE on their own sub-resources", async () => {
    const calls = stubFetch(() => ok({}));

    await deletePerson("acct-1", "people/c1");
    await deleteContactPhoto("acct-1", "people/c1");

    expect(calls.map((c) => [c.init.method, c.url.pathname])).toStrictEqual([
      ["DELETE", "/v1/people/c1:deleteContact"],
      ["DELETE", "/v1/people/c1:deleteContactPhoto"],
    ]);
    expect(calls[1]?.url.searchParams.get("personFields")).toBe(READ_PERSON_FIELDS);
  });

  it("listContactGroupsPage uses only valid field-mask paths and never requestSyncToken", async () => {
    const calls = stubFetch(() => ok({ contactGroups: [] }));

    await listContactGroupsPage("acct-1", { pageToken: "pt", syncToken: "st" });

    expect(Object.fromEntries(calls[0]!.url.searchParams)).toStrictEqual({
      pageSize: "200",
      groupFields: "name,groupType",
      pageToken: "pt",
      syncToken: "st",
    });
  });

  it("getContactGroupWithMembers asks for members without putting them in the mask", async () => {
    const calls = stubFetch(() => ok({ resourceName: "contactGroups/g1" }));

    await getContactGroupWithMembers("acct-1", "contactGroups/g1");

    expect(Object.fromEntries(calls[0]!.url.searchParams)).toStrictEqual({
      groupFields: "name,groupType,memberCount",
      maxMembers: "10000",
    });
  });

  it("createContactGroup and updateContactGroup send Google's wrapper bodies", async () => {
    const calls = stubFetch(() => ok({ resourceName: "contactGroups/g1" }));

    await createContactGroup("acct-1", "Clients");
    await updateContactGroup("acct-1", "contactGroups/g1", "Clients", "etag-1");

    expect(bodyOf(calls[0])).toStrictEqual({ contactGroup: { name: "Clients" } });
    expect(calls[1]?.init.method).toBe("PUT");
    expect(bodyOf(calls[1])).toStrictEqual({
      contactGroup: { resourceName: "contactGroups/g1", etag: "etag-1", name: "Clients" },
      updateGroupFields: "name",
    });
  });

  it("deleteContactGroup never asks Google to delete the contacts inside it", async () => {
    const calls = stubFetch(() => ok({}));

    await deleteContactGroup("acct-1", "contactGroups/g1");

    expect(calls[0]?.url.searchParams.get("deleteContacts")).toBe("false");
  });
});

describe("updateContactPhoto base64 chunking", () => {
  it("encodes a payload larger than one fromCharCode window without corrupting it", async () => {
    const calls = stubFetch(() => ok({ resourceName: "people/c1" }));
    // 100 KB: more than three 0x8000 windows, and every byte value appears.
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

    await updateContactPhoto("acct-1", "people/c1", bytes);

    const sent = bodyOf(calls[0]) as { photoBytes: string; personFields: string };
    const decoded = Uint8Array.from(atob(sent.photoBytes), (c) => c.charCodeAt(0));
    expect(decoded).toStrictEqual(bytes);
    expect(sent.personFields).toBe(READ_PERSON_FIELDS);
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.url.pathname).toBe("/v1/people/c1:updateContactPhoto");
  });

  it("encodes a payload smaller than one window identically", async () => {
    const calls = stubFetch(() => ok({}));
    const bytes = new Uint8Array([0, 1, 250, 255]);

    await updateContactPhoto("acct-1", "people/c1", bytes);

    expect((bodyOf(calls[0]) as { photoBytes: string }).photoBytes).toBe("AAH6/w==");
  });
});

describe("modifyGroupMembers batching", () => {
  const names = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `people/${prefix}${i}`);

  it("splits 1200 adds and 501 removes into three aligned 500-member passes", async () => {
    const calls = stubFetch(() => ok({}));
    const add = names("a", 1200);
    const remove = names("r", 501);

    await modifyGroupMembers("acct-1", "contactGroups/g1", add, remove);

    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.url.pathname === "/v1/contactGroups/g1/members:modify")).toBe(true);
    const bodies = calls.map(
      (c) => bodyOf(c) as { resourceNamesToAdd: string[]; resourceNamesToRemove: string[] },
    );
    expect(
      bodies.map((b) => [b.resourceNamesToAdd.length, b.resourceNamesToRemove.length]),
    ).toStrictEqual([
      [500, 500],
      [500, 1],
      [200, 0],
    ]);
    // The lists stay aligned: pass i carries chunk i of BOTH, and the shorter
    // list simply runs out rather than shifting.
    expect(bodies[0]?.resourceNamesToAdd[0]).toBe("people/a0");
    expect(bodies[1]?.resourceNamesToAdd[0]).toBe("people/a500");
    expect(bodies[1]?.resourceNamesToRemove).toStrictEqual(["people/r500"]);
    expect(bodies[2]?.resourceNamesToAdd[0]).toBe("people/a1000");
  });

  it("sends one pass when both lists fit", async () => {
    const calls = stubFetch(() => ok({}));

    await modifyGroupMembers("acct-1", "contactGroups/g1", ["people/a"], ["people/b"]);

    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toStrictEqual({
      resourceNamesToAdd: ["people/a"],
      resourceNamesToRemove: ["people/b"],
    });
  });

  it("still sends one empty pass when there is nothing to change", async () => {
    // Defensive only — both call sites guard on a non-empty delta — but the
    // floor of 1 pass means a caller that does not guard burns an API call.
    const calls = stubFetch(() => ok({}));

    await modifyGroupMembers("acct-1", "contactGroups/g1", [], []);

    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toStrictEqual({
      resourceNamesToAdd: [],
      resourceNamesToRemove: [],
    });
  });
});

describe("fetchPhotoBytes", () => {
  it("downloads the bytes and keeps Google's content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      ),
    );

    expect(await fetchPhotoBytes("https://lh3.googleusercontent.com/x")).toStrictEqual({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/png",
    });
  });

  it("defaults the mime type when the response does not declare one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: {} })),
    );

    expect(await fetchPhotoBytes("https://lh3.googleusercontent.com/x")).toMatchObject({
      mime: "image/jpeg",
    });
  });

  it.each([
    ["no url", null],
    ["an empty url", ""],
  ])("returns null for %s without fetching", async (_label, url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchPhotoBytes(url)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops quietly on a failed download, an empty body, or a thrown request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gone", { status: 404 })),
    );
    expect(await fetchPhotoBytes("https://x/1")).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(), { status: 200 })),
    );
    expect(await fetchPhotoBytes("https://x/2")).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timeout");
      }),
    );
    expect(await fetchPhotoBytes("https://x/3")).toBeNull();
  });
});
