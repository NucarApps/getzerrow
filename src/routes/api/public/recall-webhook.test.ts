// Svix signature verification for the Recall.ai webhook
// (src/routes/api/public/recall-webhook.ts). The cron-auth sweep only proves
// an unsigned request is rejected; this pins the signature contract itself,
// including the replay window a captured webhook used to sail through.

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySvix, SVIX_TOLERANCE_SECONDS } from "./recall-webhook";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const SECRET = `whsec_${KEY.toString("base64")}`;
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);

function sign(id: string, ts: number, body: string, key: Buffer = KEY): string {
  return createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

function headers(over: Record<string, string | null>, ts = Math.floor(NOW / 1000)) {
  const h = new Headers({
    "svix-id": "msg_1",
    "svix-timestamp": String(ts),
    "svix-signature": `v1,${sign("msg_1", ts, "{}")}`,
  });
  for (const [k, v] of Object.entries(over)) {
    if (v === null) h.delete(k);
    else h.set(k, v);
  }
  return h;
}

describe("verifySvix", () => {
  it("accepts a correctly signed, fresh request", () => {
    expect(verifySvix(SECRET, headers({}), "{}", NOW)).toBe(true);
  });

  it("accepts any of several space-delimited v1 signatures", () => {
    const ts = Math.floor(NOW / 1000);
    const good = sign("msg_1", ts, "{}");
    const h = headers({ "svix-signature": `v1,AAAA v1,${good}` });
    expect(verifySvix(SECRET, h, "{}", NOW)).toBe(true);
  });

  it("also accepts the secret without the whsec_ prefix", () => {
    expect(verifySvix(KEY.toString("base64"), headers({}), "{}", NOW)).toBe(true);
  });

  it.each(["svix-id", "svix-timestamp", "svix-signature"])("rejects when %s is missing", (name) => {
    expect(verifySvix(SECRET, headers({ [name]: null }), "{}", NOW)).toBe(false);
  });

  it("rejects a signature made with a different key", () => {
    const ts = Math.floor(NOW / 1000);
    const bad = sign("msg_1", ts, "{}", Buffer.from("other-key-other-key-other-key-00"));
    expect(verifySvix(SECRET, headers({ "svix-signature": `v1,${bad}` }), "{}", NOW)).toBe(false);
  });

  it("rejects when the body was altered after signing", () => {
    expect(verifySvix(SECRET, headers({}), '{"tampered":true}', NOW)).toBe(false);
  });

  it("rejects a timestamp outside the tolerance window in either direction (replay)", () => {
    const stale = Math.floor(NOW / 1000) - SVIX_TOLERANCE_SECONDS - 1;
    expect(verifySvix(SECRET, headers({}, stale), "{}", NOW)).toBe(false);
    const future = Math.floor(NOW / 1000) + SVIX_TOLERANCE_SECONDS + 1;
    expect(verifySvix(SECRET, headers({}, future), "{}", NOW)).toBe(false);
    const edge = Math.floor(NOW / 1000) - SVIX_TOLERANCE_SECONDS;
    expect(verifySvix(SECRET, headers({}, edge), "{}", NOW)).toBe(true);
  });

  it("rejects a non-numeric timestamp", () => {
    const h = headers({ "svix-timestamp": "yesterday" });
    expect(verifySvix(SECRET, h, "{}", NOW)).toBe(false);
  });
});
