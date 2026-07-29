import { describe, it, expect } from "vitest";
import { deriveOriginSender, effectiveSender, parseViaDisplayName } from "./origin-sender";

/** Build a case-insensitive header lookup from a plain object. */
function headers(map: Record<string, string>) {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return (name: string) => lower.get(name.toLowerCase()) ?? "";
}

describe("parseViaDisplayName", () => {
  it("splits Google's relay display name", () => {
    expect(parseViaDisplayName('"Manheim" via Old User Ken Connor')).toEqual({
      originName: "Manheim",
      forwarderName: "Old User Ken Connor",
    });
  });

  it("ignores names without a via segment", () => {
    expect(parseViaDisplayName("Manheim Auctions")).toBeNull();
    expect(parseViaDisplayName("")).toBeNull();
    expect(parseViaDisplayName(null)).toBeNull();
  });
});

describe("deriveOriginSender", () => {
  it("recovers the sender Gmail rewrote for DMARC", () => {
    const r = deriveOriginSender(
      headers({
        From: '"Manheim" via Old User Ken Connor <kconnor@nucar.com>',
        "X-Google-Original-From": '"Manheim" <news@manheim.com>',
        "List-Id": "<kconnor.nucar.com>",
      }),
    );
    expect(r.origin_addr).toBe("news@manheim.com");
    expect(r.forwarder_name).toBe("Old User Ken Connor");
    expect(r.is_forwarded).toBe(true);
  });

  it("uses X-Original-Sender for Google Groups posts", () => {
    const r = deriveOriginSender(
      headers({
        From: "Manheim via Old User Ken Connor <kconnor@nucar.com>",
        "X-Original-Sender": "news@manheim.com",
        "List-Id": "<kconnor.nucar.com>",
      }),
    );
    expect(r.origin_addr).toBe("news@manheim.com");
  });

  it("flags relayed mail as forwarded even when no header names an address", () => {
    const r = deriveOriginSender(
      headers({
        From: '"Manheim" via Old User Ken Connor <kconnor@nucar.com>',
        "List-Id": "<kconnor.nucar.com>",
      }),
    );
    expect(r.origin_addr).toBeNull();
    expect(r.origin_name).toBe("Manheim");
    expect(r.is_forwarded).toBe(true);
  });

  it("treats a cross-domain Reply-To as the origin", () => {
    const r = deriveOriginSender(
      headers({
        From: "Ken Connor <kconnor@nucar.com>",
        "Reply-To": "ana.drouin@statefarm.com",
      }),
    );
    expect(r.origin_addr).toBe("ana.drouin@statefarm.com");
    expect(r.reply_to_addr).toBe("ana.drouin@statefarm.com");
    expect(r.is_forwarded).toBe(true);
  });

  it("ignores a same-domain Reply-To alias", () => {
    const r = deriveOriginSender(
      headers({
        From: "Sales <sales@nucar.com>",
        "Reply-To": "no-reply@nucar.com",
      }),
    );
    expect(r.origin_addr).toBeNull();
    expect(r.is_forwarded).toBe(false);
    expect(r.reply_to_addr).toBe("no-reply@nucar.com");
  });

  it("leaves ordinary mail untouched", () => {
    const r = deriveOriginSender(headers({ From: "Tracy Noel <tnoel@nucar.com>" }));
    expect(r).toEqual({
      reply_to_addr: null,
      origin_addr: null,
      origin_name: null,
      forwarder_name: null,
      is_forwarded: false,
    });
  });

  it("takes the last address of X-Forwarded-For", () => {
    const r = deriveOriginSender(
      headers({
        From: "Ken Connor <kconnor@nucar.com>",
        "X-Forwarded-For": "kconnor@nucar.com news@manheim.com",
      }),
    );
    expect(r.origin_addr).toBe("news@manheim.com");
  });
});

describe("effectiveSender", () => {
  it("prefers the origin and falls back to From", () => {
    expect(effectiveSender({ from_addr: "a@x.com", origin_addr: "b@y.com" })).toBe("b@y.com");
    expect(effectiveSender({ from_addr: "A@X.com" })).toBe("a@x.com");
    expect(effectiveSender({})).toBe("");
  });
});
