import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isAuthorizedCron, unauthorizedResponse } from "./cron-auth.server";

const SECRET = "test-secret-abcdef1234567890";

describe("isAuthorizedCron", () => {
  const originalEnv = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalEnv;
  });

  function reqWith(headers: Record<string, string>): Request {
    return new Request("https://example.com/api/public/anything", { headers });
  }

  it("rejects requests with no auth header", () => {
    expect(isAuthorizedCron(reqWith({}))).toBe(false);
  });

  it("rejects malformed Bearer header", () => {
    expect(isAuthorizedCron(reqWith({ authorization: "Bearer" }))).toBe(false);
    expect(isAuthorizedCron(reqWith({ authorization: "Basic " + SECRET }))).toBe(false);
  });

  it("rejects wrong secret via Bearer", () => {
    expect(isAuthorizedCron(reqWith({ authorization: "Bearer wrong-secret-value" }))).toBe(false);
    expect(isAuthorizedCron(reqWith({ authorization: `Bearer ${SECRET}x` }))).toBe(false);
  });

  it("rejects wrong secret via x-cron-secret header", () => {
    expect(isAuthorizedCron(reqWith({ "x-cron-secret": "nope" }))).toBe(false);
  });

  it("rejects when CRON_SECRET env is not set", () => {
    delete process.env.CRON_SECRET;
    expect(isAuthorizedCron(reqWith({ authorization: `Bearer ${SECRET}` }))).toBe(false);
  });

  it("rejects same-length but mismatched secret (constant-time path)", () => {
    const tampered = SECRET.slice(0, -1) + (SECRET.endsWith("0") ? "1" : "0");
    expect(tampered.length).toBe(SECRET.length);
    expect(isAuthorizedCron(reqWith({ authorization: `Bearer ${tampered}` }))).toBe(false);
  });

  it("accepts correct secret via Bearer header", () => {
    expect(isAuthorizedCron(reqWith({ authorization: `Bearer ${SECRET}` }))).toBe(true);
  });

  it("accepts correct secret via x-cron-secret header", () => {
    expect(isAuthorizedCron(reqWith({ "x-cron-secret": SECRET }))).toBe(true);
  });

  it("unauthorizedResponse returns 401", () => {
    const res = unauthorizedResponse();
    expect(res.status).toBe(401);
  });
});
