// "Sync to Google now" (push-photo-now.functions.ts) — the last untested
// server module of any size.
//
// Both fns are user-triggered and take a client-supplied id, so ownership
// is the first contract; after that, the interesting ones are all about
// what this does NOT do:
//
//   * it does not push inline. Awaiting the sync can exceed Safari's
//     fetch wall on a large account (which surfaces as an opaque "Load
//     failed") and leaks the sync lease if the worker is killed, so it
//     kicks a background hook and returns. A hook that could not be
//     kicked is reported as `background_sync_unavailable` rather than
//     claimed as queued,
//   * it does not mark anything dirty until it knows there is both a
//     photo to send and an account to send it to — a dirty link with
//     nothing to push just burns retries,
//   * the photo pre-check uses the SAME resolver as the push worker, so
//     a contact wearing a company logo counts as having a photo; a
//     narrower check here would refuse a sync the worker would have
//     completed,
//   * `recentFailures` carries the concrete People API reason so the UI
//     can replace "Load failed" with something actionable — and is empty
//     rather than absent when nothing has failed.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const assertOwnsContact = vi.fn(async () => {});
const assertOwnsCompany = vi.fn(async () => {});
vi.mock("@/lib/ownership", () => ({
  assertOwnsContact: (...a: unknown[]) => assertOwnsContact(...(a as [])),
  assertOwnsCompany: (...a: unknown[]) => assertOwnsCompany(...(a as [])),
}));

const kickHook = vi.fn();
vi.mock("../self-url.server", () => ({ kickHook: (...a: unknown[]) => kickHook(...a) }));

const markGooglePhotoDirty = vi.fn(async () => {});
const markGooglePhotoDirtyMany = vi.fn(async () => {});
vi.mock("./mark-dirty.server", () => ({
  markGooglePhotoDirty: (...a: unknown[]) => markGooglePhotoDirty(...(a as [])),
  markGooglePhotoDirtyMany: (...a: unknown[]) => markGooglePhotoDirtyMany(...(a as [])),
}));

const resolveEffectiveContactPhotoForSync = vi.fn();
vi.mock("@/lib/contacts/logo-photo.server", () => ({
  resolveEffectiveContactPhotoForSync: (...a: unknown[]) =>
    resolveEffectiveContactPhotoForSync(...(a as [])),
}));

const { pushContactPhotoToGoogleNow, pushCompanyPhotoToGoogleNow } =
  await import("./push-photo-now.functions");

const CONTACT = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER_CONTACT = "33333333-3333-4333-8333-333333333333";

type PushResult = {
  contactsMarked: number;
  accountsQueued: number;
  errors: string[];
  recentFailures: Array<Record<string, unknown>>;
};

const pushContact = (contactId = CONTACT) =>
  impersonate(
    pushContactPhotoToGoogleNow,
    TEST_USER,
  )({
    data: { contactId },
  }) as Promise<PushResult>;
const pushCompany = (companyId = COMPANY) =>
  impersonate(
    pushCompanyPhotoToGoogleNow,
    TEST_USER,
  )({
    data: { companyId },
  }) as Promise<PushResult>;

/** A link row that makes the contact pushable to one Gmail account. */
const link = (
  contactId: string,
  gmail_account_id = "acct-1",
  over: Record<string, unknown> = {},
) => ({
  user_id: TEST_USER,
  contact_id: contactId,
  gmail_account_id,
  last_photo_error: null,
  last_photo_error_at: null,
  last_photo_status: null,
  last_photo_reason: null,
  photo_push_attempts: null,
  ...over,
});

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  assertOwnsContact.mockResolvedValue(undefined);
  assertOwnsCompany.mockResolvedValue(undefined);
  resolveEffectiveContactPhotoForSync.mockResolvedValue({ bytes: new Uint8Array([1]) });
  kickHook.mockResolvedValue({ response: Promise.resolve() });
  markGooglePhotoDirty.mockResolvedValue(undefined);
  markGooglePhotoDirtyMany.mockResolvedValue(undefined);
});

describe("pushContactPhotoToGoogleNow ownership", () => {
  it("checks ownership before anything else", async () => {
    assertOwnsContact.mockRejectedValue(new Error("Forbidden"));
    await expect(pushContact()).rejects.toThrow("Forbidden");
    expect(writeCount(fake)).toBe(0);
    expect(markGooglePhotoDirty).not.toHaveBeenCalled();
    expect(kickHook).not.toHaveBeenCalled();
  });

  it("checks the contact the caller named, as the caller", async () => {
    fake.seedRaw("google_contact_links", [link(CONTACT)]);
    await pushContact();
    expect(assertOwnsContact).toHaveBeenCalledWith(TEST_USER, CONTACT);
  });

  it("rejects a non-uuid contact id", async () => {
    await expect(
      impersonate(pushContactPhotoToGoogleNow, TEST_USER)({ data: { contactId: "nope" } }),
    ).rejects.toThrow();
    expect(assertOwnsContact).not.toHaveBeenCalled();
  });
});

describe("pushContactPhotoToGoogleNow pre-checks", () => {
  it("refuses when the contact has no photo, and marks nothing dirty", async () => {
    // A dirty link with nothing to push just burns the retry counter.
    resolveEffectiveContactPhotoForSync.mockResolvedValue(null);

    const res = await pushContact();

    expect(res).toMatchObject({
      contactsMarked: 0,
      accountsQueued: 0,
      errors: ["no_photo_on_contact"],
    });
    expect(markGooglePhotoDirty).not.toHaveBeenCalled();
    expect(kickHook).not.toHaveBeenCalled();
  });

  it("counts a company logo as a photo, because the worker would too", async () => {
    // The pre-check uses the push worker's own resolver; a narrower check
    // here would refuse a sync the worker would have completed.
    resolveEffectiveContactPhotoForSync.mockResolvedValue({ bytes: new Uint8Array([2]) });
    fake.seedRaw("google_contact_links", [link(CONTACT)]);

    expect(await pushContact()).toMatchObject({ contactsMarked: 1, errors: [] });
    expect(resolveEffectiveContactPhotoForSync).toHaveBeenCalledWith(TEST_USER, CONTACT);
  });

  it("refuses when the contact is not linked to any Google account", async () => {
    expect(await pushContact()).toMatchObject({
      contactsMarked: 0,
      accountsQueued: 0,
      errors: ["not_linked_to_google"],
      recentFailures: [],
    });
    expect(markGooglePhotoDirty).not.toHaveBeenCalled();
  });

  it("scopes the link lookup to the caller and the contact", async () => {
    fake.seedRaw("google_contact_links", [link(CONTACT)]);
    await pushContact();
    const linkSelect = fake.calls.selects.find(
      (s) => s.table === "google_contact_links" && s.columns === "gmail_account_id",
    );
    expect(linkSelect?.filters).toEqual([
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
      { op: "eq", col: "contact_id", value: CONTACT, extra: undefined },
    ]);
  });
});

describe("pushContactPhotoToGoogleNow queueing", () => {
  beforeEach(() => {
    fake.seedRaw("google_contact_links", [link(CONTACT, "acct-1"), link(CONTACT, "acct-2")]);
  });

  it("marks the contact dirty and kicks the background hook", async () => {
    const res = await pushContact();

    expect(markGooglePhotoDirty).toHaveBeenCalledWith(TEST_USER, CONTACT);
    expect(kickHook).toHaveBeenCalledWith("/api/public/hooks/google-contacts-sync", {
      keepalive: true,
    });
    expect(res).toMatchObject({ contactsMarked: 1, accountsQueued: 2, errors: [] });
  });

  it("counts each account once however many links point at it", async () => {
    fake.reset();
    fake.seedRaw("google_contact_links", [link(CONTACT, "acct-1"), link(CONTACT, "acct-1")]);
    expect((await pushContact()).accountsQueued).toBe(1);
  });

  it("says the sync is unavailable rather than claiming it was queued", async () => {
    // A missing host or secret means only the periodic cron will pick it
    // up; reporting "queued" would leave the user waiting on nothing.
    kickHook.mockResolvedValue(null);

    const res = await pushContact();

    expect(res).toMatchObject({
      contactsMarked: 1,
      accountsQueued: 0,
      errors: ["background_sync_unavailable"],
    });
    // The contact is still marked, so the next cron tick carries it.
    expect(markGooglePhotoDirty).toHaveBeenCalled();
  });

  it("treats a thrown kick the same way", async () => {
    kickHook.mockRejectedValue(new Error("no self URL"));
    expect((await pushContact()).errors).toEqual(["background_sync_unavailable"]);
  });

  it("does not wait on the kicked request, or fail when it rejects", async () => {
    // The point of the hook is that this fn returns immediately; a
    // rejection there must not become an unhandled rejection either.
    kickHook.mockResolvedValue({ response: Promise.reject(new Error("hook 500")) });
    expect((await pushContact()).accountsQueued).toBe(2);
  });
});

describe("recentFailures", () => {
  it("reports the concrete People API reason for a failed link", async () => {
    fake.seedRaw("google_contact_links", [
      link(CONTACT, "acct-1", {
        last_photo_error: "insufficient scope",
        last_photo_error_at: "2026-09-01T00:00:00.000Z",
        last_photo_status: 403,
        last_photo_reason: "forbidden",
        photo_push_attempts: 3,
      }),
    ]);

    const res = await pushContact();

    expect(res.recentFailures).toEqual([
      {
        contactId: CONTACT,
        gmailAccountId: "acct-1",
        error: "insufficient scope",
        status: 403,
        reason: "forbidden",
        at: "2026-09-01T00:00:00.000Z",
        attempts: 3,
      },
    ]);
  });

  it("defaults a missing status, reason and attempt count", async () => {
    fake.seedRaw("google_contact_links", [
      link(CONTACT, "acct-1", {
        last_photo_error: "Load failed",
        last_photo_error_at: "2026-09-01T00:00:00.000Z",
      }),
    ]);

    expect((await pushContact()).recentFailures[0]).toMatchObject({
      status: null,
      reason: null,
      attempts: 0,
    });
  });

  it("drops a row with an error but no timestamp", async () => {
    // Half-written failure state is not something to show the user.
    fake.seedRaw("google_contact_links", [
      link(CONTACT, "acct-1", { last_photo_error: "boom", last_photo_error_at: null }),
    ]);
    expect((await pushContact()).recentFailures).toEqual([]);
  });

  it("is an empty list, not absent, when nothing has failed", async () => {
    fake.seedRaw("google_contact_links", [link(CONTACT)]);
    expect((await pushContact()).recentFailures).toEqual([]);
  });

  it("asks only for rows that actually carry an error, scoped to the caller", async () => {
    fake.seedRaw("google_contact_links", [link(CONTACT)]);
    await pushContact();

    const failureSelect = fake.calls.selects.find((s) =>
      (s.columns ?? "").includes("last_photo_error"),
    );
    expect(failureSelect?.filters).toEqual([
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
      { op: "in", col: "contact_id", value: [CONTACT], extra: undefined },
      { op: "not", col: "last_photo_error", value: null, extra: "is" },
    ]);
  });
});

describe("pushCompanyPhotoToGoogleNow", () => {
  const seedMembers = () => {
    fake.seedRaw("contacts", [
      { id: CONTACT, user_id: TEST_USER, company_id: COMPANY },
      { id: OTHER_CONTACT, user_id: TEST_USER, company_id: COMPANY },
      { id: "elsewhere", user_id: TEST_USER, company_id: "other-co" },
    ]);
  };

  it("checks ownership of the company before anything else", async () => {
    assertOwnsCompany.mockRejectedValue(new Error("Forbidden"));
    await expect(pushCompany()).rejects.toThrow("Forbidden");
    expect(markGooglePhotoDirtyMany).not.toHaveBeenCalled();
    expect(kickHook).not.toHaveBeenCalled();
  });

  it("refuses a company with no members", async () => {
    expect(await pushCompany()).toMatchObject({
      contactsMarked: 0,
      accountsQueued: 0,
      errors: ["no_members"],
      recentFailures: [],
    });
  });

  it("marks exactly this company's members dirty", async () => {
    seedMembers();
    fake.seedRaw("google_contact_links", [link(CONTACT), link(OTHER_CONTACT)]);

    const res = await pushCompany();

    // The contact at another company must not be touched.
    expect(markGooglePhotoDirtyMany).toHaveBeenCalledWith(TEST_USER, [CONTACT, OTHER_CONTACT]);
    expect(res).toMatchObject({ contactsMarked: 2, accountsQueued: 1, errors: [] });
  });

  it("refuses when no member is linked to Google", async () => {
    seedMembers();
    expect(await pushCompany()).toMatchObject({
      contactsMarked: 0,
      errors: ["not_linked_to_google"],
    });
    expect(markGooglePhotoDirtyMany).not.toHaveBeenCalled();
  });

  it("does not pre-check photos, since members are handled per contact", async () => {
    // The per-contact resolver runs inside the push worker for a bulk
    // push; checking here would need one resolve per member.
    seedMembers();
    fake.seedRaw("google_contact_links", [link(CONTACT)]);
    await pushCompany();
    expect(resolveEffectiveContactPhotoForSync).not.toHaveBeenCalled();
  });

  it("scopes the member lookup to the caller", async () => {
    seedMembers();
    await pushCompany();
    expect(fake.calls.selects[0]).toMatchObject({
      table: "contacts",
      filters: [
        { op: "eq", col: "user_id", value: TEST_USER },
        { op: "eq", col: "company_id", value: COMPANY },
      ],
    });
  });

  it("reports failures across every member", async () => {
    seedMembers();
    fake.seedRaw("google_contact_links", [
      link(CONTACT),
      link(OTHER_CONTACT, "acct-1", {
        last_photo_error: "quota",
        last_photo_error_at: "2026-09-01T00:00:00.000Z",
        last_photo_status: 429,
      }),
    ]);

    const res = await pushCompany();

    expect(res.recentFailures).toHaveLength(1);
    expect(res.recentFailures[0]).toMatchObject({ contactId: OTHER_CONTACT, status: 429 });
  });

  it("says the sync is unavailable rather than claiming it was queued", async () => {
    seedMembers();
    fake.seedRaw("google_contact_links", [link(CONTACT)]);
    kickHook.mockResolvedValue(null);

    expect(await pushCompany()).toMatchObject({
      contactsMarked: 2,
      accountsQueued: 0,
      errors: ["background_sync_unavailable"],
    });
  });

  it("rejects a non-uuid company id", async () => {
    await expect(
      impersonate(pushCompanyPhotoToGoogleNow, TEST_USER)({ data: { companyId: "nope" } }),
    ).rejects.toThrow();
    expect(assertOwnsCompany).not.toHaveBeenCalled();
  });
});
