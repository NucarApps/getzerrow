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
    let capturedUrl: string | null = null;
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      capturedUrl = input.toString();
      return new Response(JSON.stringify({ contactGroups: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await listContactGroupsPage("account-1", {});

    expect(capturedUrl).toBeTypeOf("string");
    if (!capturedUrl) throw new Error("Expected fetch URL string");
    const requested = new URL(capturedUrl);
    const groupFields = requested.searchParams.get("groupFields");

    expect(groupFields).toBe("name,groupType");
    expect(groupFields).not.toContain("formattedName");
    expect(groupFields).not.toContain("formatted_name");
  });
});