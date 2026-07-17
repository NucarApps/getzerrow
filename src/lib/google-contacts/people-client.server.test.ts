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

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBeTypeOf("string");
    const requested = new URL(url as string);
    const groupFields = requested.searchParams.get("groupFields");

    expect(groupFields).toBe("name,groupType");
    expect(groupFields).not.toContain("formattedName");
    expect(groupFields).not.toContain("formatted_name");
  });
});