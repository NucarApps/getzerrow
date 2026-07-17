import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/google-oauth.server", () => ({
  getAccessToken: vi.fn(async () => "test-access-token"),
}));

import { listContactGroupsPage } from "./people-client.server";

describe("listContactGroupsPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses only valid contactGroups.list field mask paths", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ contactGroups: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listContactGroupsPage("account-1", {});

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const url = firstCall?.[0];
    expect(url).toBeTypeOf("string");
    if (typeof url !== "string") throw new Error("Expected fetch URL string");
    const requested = new URL(url);
    const groupFields = requested.searchParams.get("groupFields");

    expect(groupFields).toBe("name,groupType");
    expect(groupFields).not.toContain("formattedName");
    expect(groupFields).not.toContain("formatted_name");
  });
});